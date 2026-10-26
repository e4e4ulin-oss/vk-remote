// VK Remote — пульт для музыки ВК с телефона.
// Запуск: node server.js   (Node 18+, без зависимостей)
//
// Схема:
//   телефон  --(Wi-Fi, токен)-->  этот сервер  <--(127.0.0.1, long-poll)--  юзерскрипт во вкладке vk.com
// Если вкладка VK не на связи, play/pause/next/prev уходят системными медиаклавишами (Windows).

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.VK_REMOTE_PORT || 8765);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AGENT_TIMEOUT_MS = 35_000;

// В фоне консоли нет — пишем лог в файл (перезаписывается при каждом запуске).
if (process.env.VK_REMOTE_LOG) {
  const out = fs.createWriteStream(process.env.VK_REMOTE_LOG, { flags: 'w' });
  console.log = (...args) => out.write(args.join(' ') + '\n');
}
const POLL_HOLD_MS = 25_000;

// ---------- конфиг с токеном ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    const cfg = { token: crypto.randomBytes(8).toString('hex') };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}
const config = loadConfig();

// ---------- состояние ----------
// agents: id -> { lastSeen, playing, queue: [], waiter: res|null }
const agents = new Map();
let primaryId = null;
let nowPlaying = null;   // { title, artist, cover, playing, position, duration, volume, mode }
let list = { version: 0, id: null, title: '', tracks: [], error: null };
let diag = null;
let diagSeq = 0;
let lastError = null;
let cmdSeq = 0;

function aliveAgents() {
  const now = Date.now();
  for (const [id, a] of agents) {
    if (now - a.lastSeen > AGENT_TIMEOUT_MS) {
      if (a.waiter) endJson(a.waiter, 200, { commands: [] });
      agents.delete(id);
    }
  }
  return agents;
}

// Команды получает одна вкладка: та, что последней сообщила "играю", иначе самая свежая.
function pickPrimary() {
  aliveAgents();
  if (primaryId && agents.has(primaryId)) return agents.get(primaryId);
  let best = null;
  for (const [id, a] of agents) if (!best || a.lastSeen > best.a.lastSeen) best = { id, a };
  primaryId = best ? best.id : null;
  return best ? best.a : null;
}

function flush(agent) {
  if (agent.waiter && agent.queue.length) {
    endJson(agent.waiter, 200, { commands: agent.queue.splice(0) });
    agent.waiter = null;
  }
}

// ---------- медиаклавиши (fallback) ----------
const MEDIA_KEYS = { toggle: 179, play: 179, pause: 179, next: 176, prev: 177 };
function pressMediaKey(name) {
  const code = MEDIA_KEYS[name];
  if (!code) return Promise.resolve(false);
  if (process.platform !== 'win32') return Promise.resolve(false);
  const ps = `(New-Object -ComObject WScript.Shell).SendKeys([char]${code})`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err) =>
      resolve(!err)
    );
  });
}

// ---------- http утилиты ----------
function endJson(res, code, obj) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function tokenOk(req, url) {
  const t = req.headers['x-token'] || url.searchParams.get('k') || '';
  const a = Buffer.from(String(t));
  const b = Buffer.from(config.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicState() {
  const agent = pickPrimary();
  return {
    agentOnline: !!agent,
    agents: agents.size,
    mediaKeys: process.platform === 'win32',
    nowPlaying,
    listVersion: list.version,
    diagAvailable: !!diag,
    lastError,
  };
}

// ---------- обработчики ----------
const TRANSPORT = new Set(['toggle', 'play', 'pause', 'next', 'prev']);

async function handleCommand(cmd) {
  if (!cmd || typeof cmd.type !== 'string') return { ok: false, error: 'bad command' };
  lastError = null;
  const agent = pickPrimary();
  if (agent) {
    agent.queue.push({ ...cmd, id: ++cmdSeq });
    flush(agent);
    return { ok: true, via: 'agent' };
  }
  if (TRANSPORT.has(cmd.type)) {
    const ok = await pressMediaKey(cmd.type);
    return ok ? { ok: true, via: 'mediakey' } : { ok: false, error: 'Вкладка VK не на связи, а медиаклавиши недоступны' };
  }
  return { ok: false, error: 'Вкладка VK не на связи: открой vk.com на ПК (юзерскрипт должен быть включён)' };
}

async function handleAgent(req, res, url) {
  const id = String(url.searchParams.get('agent') || '').slice(0, 64);
  if (!id) return endJson(res, 400, { error: 'no agent id' });
  let agent = agents.get(id);
  if (!agent) {
    agent = { lastSeen: Date.now(), playing: false, queue: [], waiter: null };
    agents.set(id, agent);
    log(`вкладка VK подключилась (${id.slice(0, 6)})`);
  }
  agent.lastSeen = Date.now();

  if (url.pathname === '/agent/poll' && req.method === 'GET') {
    if (agent.waiter) endJson(agent.waiter, 200, { commands: [] });
    agent.waiter = res;
    const timer = setTimeout(() => {
      if (agent.waiter === res) { agent.waiter = null; endJson(res, 200, { commands: [] }); }
    }, POLL_HOLD_MS);
    res.on('close', () => { clearTimeout(timer); if (agent.waiter === res) agent.waiter = null; });
    if (primaryId === id) flush(agent);
    return;
  }

  if (req.method !== 'POST') return endJson(res, 405, { error: 'method' });
  const body = await readBody(req);

  switch (url.pathname) {
    case '/agent/state':
      agent.playing = !!(body && body.playing);
      if (agent.playing) primaryId = id;
      if (primaryId === id || !nowPlaying) nowPlaying = body;
      return endJson(res, 200, { ok: true, primary: primaryId === id });
    case '/agent/list':
      list = {
        version: list.version + 1,
        id: body.id || null,
        title: String(body.title || ''),
        tracks: Array.isArray(body.tracks) ? body.tracks.slice(0, 500) : [],
        error: body.error || null,
      };
      return endJson(res, 200, { ok: true });
    case '/agent/diag':
      diag = { ...body, seq: ++diagSeq };
      return endJson(res, 200, { ok: true });
    case '/agent/error':
      lastError = String(body.message || 'ошибка');
      log('агент: ' + lastError);
      return endJson(res, 200, { ok: true });
    case '/agent/mediakey':
      return endJson(res, 200, { ok: await pressMediaKey(body.key) });
    default:
      return endJson(res, 404, { error: 'not found' });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/agent/')) {
    if (!isLoopback(req)) return endJson(res, 403, { error: 'agent only from localhost' });
    return handleAgent(req, res, url);
  }

  if (url.pathname === '/ping') return endJson(res, 200, { app: 'vk-remote' });

  if (url.pathname === '/qrcode.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', 'qrcode.js')).pipe(res);
  }

  if (url.pathname === '/vk-remote.user.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'vk-remote.user.js')).pipe(res);
  }

  // Остановка — только с ПК и только с заголовком X-VKR: обычный сайт в браузере
  // не может послать такой запрос на localhost без CORS-разрешения, которого мы не даём.
  if (url.pathname === '/shutdown') {
    if (!isLoopback(req) || req.method !== 'POST' || req.headers['x-vkr'] !== '1') return endJson(res, 403, { error: 'forbidden' });
    log('остановка по запросу');
    endJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 200);
    return;
  }

  // Страница настройки и её данные — только с самого ПК.
  if (url.pathname === '/setup' || url.pathname === '/setup-info') {
    if (!isLoopback(req)) return endJson(res, 403, { error: 'only from this PC' });
    if (url.pathname === '/setup-info') {
      const urls = lanAddresses().map((ip) => `http://${ip}:${PORT}/?k=${config.token}`);
      return endJson(res, 200, { token: config.token, phoneUrls: urls, agentOnline: !!pickPrimary() });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'public', 'setup.html')).pipe(res);
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!tokenOk(req, url)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Нужна ссылка с ключом — её печатает сервер при запуске.');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }

  if (url.pathname.startsWith('/api/')) {
    if (!tokenOk(req, url)) return endJson(res, 403, { error: 'bad token' });
    if (url.pathname === '/api/state') return endJson(res, 200, publicState());
    if (url.pathname === '/api/list') return endJson(res, 200, list);
    if (url.pathname === '/api/diag') return endJson(res, 200, diag || {});
    if (url.pathname === '/api/cmd' && req.method === 'POST') return endJson(res, 200, await handleCommand(await readBody(req)));
  }

  endJson(res, 404, { error: 'not found' });
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// Домашний Wi-Fi обычно 192.168.x.x — ставим его первым (VPN и виртуалки в конец).
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('ошибка: ' + e.message);
    endJson(res, 500, { error: e.message });
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`Порт ${PORT} уже занят — VK Remote, похоже, уже запущен.`);
  else console.log('Не удалось запустить сервер: ' + e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nVK Remote запущен. Открой на телефоне (тот же Wi-Fi):\n');
  for (const ip of lanAddresses()) console.log(`   http://${ip}:${PORT}/?k=${config.token}`);
  console.log(`\nНа ПК: http://127.0.0.1:${PORT}/?k=${config.token}`);
  console.log('Ключ лежит в config.json — удали файл, чтобы сгенерировать новый.\n');
  if (!process.env.VK_REMOTE_LOG) console.log('Не закрывай это окно, пока пользуешься пультом.\n');
  if (process.env.VK_REMOTE_OPEN && process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}/setup`], { windowsHide: true });
  }
});
