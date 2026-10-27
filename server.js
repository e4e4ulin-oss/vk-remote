// VK Remote — пульт для музыки ВК с телефона.
// Запуск: node server.js   (Node 18+, без зависимостей)
//
// Схема:
//   телефон  --(Wi-Fi, токен)-->  этот сервер  <--(127.0.0.1, long-poll)--  юзерскрипт во вкладке vk.com
// Если вкладка VK не на связи, play/pause/next/prev уходят системными медиаклавишами (Windows).
//
// Режим «без расширений» (VK_REMOTE_CDP=1, ярлык «Управлять музыкой через ВК»): вместо Tampermonkey
// сервер сам открывает окно браузера и внедряет агент через протокол отладки — см. browser.js.

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const PORT = Number(process.env.VK_REMOTE_PORT || 27613);
// Папка с данными (ключ, лог, профиль браузера). У установки через «Установить пульт VK.bat» она
// отдельно от программы (--data), чтобы обновление не стирало ключ и вход в VK.
const dataArg = process.argv.indexOf('--data');
const DATA_DIR = path.resolve(dataArg > 0 ? process.argv[dataArg + 1] : process.env.VK_REMOTE_DATA || __dirname);
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const AGENT_TIMEOUT_MS = 35_000;
const CDP_MODE = process.env.VK_REMOTE_CDP === '1';

const LOG_PATH = path.join(DATA_DIR, 'runtime', 'server.log');
const POLL_HOLD_MS = 25_000;

// ---------- конфиг с токеном ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    const cfg = { token: crypto.randomBytes(8).toString('hex') };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}
const config = loadConfig();

const browser = CDP_MODE
  ? require('./browser').createBrowserControl({
      dataDir: DATA_DIR,
      appDir: __dirname,
      serverPort: PORT,
      log: (m) => log(m),
      browserPath: config.browserPath,
      // Окно закрыли — сразу показываем это на телефоне, не дожидаясь таймаута агента.
      onDisconnect: () => {
        for (const a of agents.values()) if (a.waiter) endJson(a.waiter, 200, { commands: [] });
        agents.clear();
        primaryId = null;
        if (nowPlaying) nowPlaying = { ...nowPlaying, playing: false };
      },
    })
  : null;

// ---------- состояние ----------
// agents: id -> { lastSeen, playing, queue: [], waiter: res|null }
const agents = new Map();
let primaryId = null;
let nowPlaying = null;   // { title, artist, cover, playing, position, duration, volume, mode }
let list = { version: 0, id: null, title: '', tracks: [], error: null };
let diag = null;
// Значок в трее (tray.ps1): когда последний раз опрашивал сервер и ждёт ли он команду «покажи QR».
const tray = { lastSeen: 0, showQr: false, spawns: 0, child: null };
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
    canLaunch: !!browser,
    lastError,
  };
}

// ---------- обработчики ----------
const TRANSPORT = new Set(['toggle', 'play', 'pause', 'next', 'prev']);

async function handleCommand(cmd) {
  if (!cmd || typeof cmd.type !== 'string') return { ok: false, error: 'bad command' };
  lastError = null;
  if (cmd.type === 'launch') {
    if (!browser) return { ok: false, error: 'Открой vk.com на ПК вручную' };
    return browser.ensureBrowser();
  }
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
  if (browser) return { ok: false, error: 'Окно VK на ПК закрыто — нажми «Открыть VK на компьютере»' };
  return { ok: false, error: 'Вкладка VK не на связи: открой vk.com на ПК (юзерскрипт должен быть включён)' };
}

async function handleAgent(req, res, url) {
  const id = String(url.searchParams.get('agent') || '').slice(0, 64);
  if (!id) return endJson(res, 400, { error: 'no agent id' });
  let agent = agents.get(id);
  if (!agent) {
    agent = { lastSeen: Date.now(), playing: false, queue: [], waiter: null };
    // В режиме окна вкладка VK одна: новый агент значит, что страница перезагрузилась,
    // и прежний уже мёртв — иначе команды ещё 35 с уходили бы ему.
    if (browser) {
      for (const [oid, a] of agents) {
        if (a.waiter) endJson(a.waiter, 200, { commands: [] });
        agents.delete(oid);
      }
      primaryId = id;
    }
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
        note: body.note || null,
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
    if (tray.child) tray.child.kill();
    endJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 200);
    return;
  }

  // Значок в трее — только с ПК. GET без побочных эффектов, кроме отметки «значок жив».
  if (url.pathname === '/tray/poll' || url.pathname === '/tray/qr') {
    if (!isLoopback(req)) return endJson(res, 403, { error: 'only from this PC' });
    tray.lastSeen = Date.now();
    if (url.pathname === '/tray/poll') {
      const showQr = tray.showQr;
      tray.showQr = false;
      return endJson(res, 200, { showQr, agentOnline: !!pickPrimary() });
    }
    const urls = lanAddresses().map((ip) => `http://${ip}:${PORT}/?k=${config.token}`);
    if (!urls.length) return endJson(res, 200, { url: 'ПК не подключён к сети', gif: null, count: 0, agentOnline: !!pickPrimary() });
    const i = Math.abs(Number(url.searchParams.get('i')) || 0) % urls.length;
    return endJson(res, 200, { url: urls[i], gif: qrGif(urls[i]), count: urls.length, agentOnline: !!pickPrimary() });
  }

  // Ярлык просит показать окно с QR. Ждём, пока значок заберёт просьбу: если значка нет,
  // ярлык откроет страницу настройки в браузере.
  if (url.pathname === '/local/show-qr') {
    if (!isLoopback(req) || req.method !== 'POST' || req.headers['x-vkr'] !== '1') return endJson(res, 403, { error: 'forbidden' });
    tray.showQr = true;
    for (let i = 0; i < 30 && tray.showQr; i++) await new Promise((r) => setTimeout(r, 200));
    const shown = !tray.showQr;
    tray.showQr = false;
    return endJson(res, 200, { shown });
  }

  if (url.pathname === '/local/launch') {
    if (!isLoopback(req) || req.method !== 'POST' || req.headers['x-vkr'] !== '1') return endJson(res, 403, { error: 'forbidden' });
    return endJson(res, 200, browser ? await browser.ensureBrowser() : { ok: false, error: 'not in browser mode' });
  }

  // Страница настройки и её данные — только с самого ПК.
  if (url.pathname === '/setup' || url.pathname === '/setup-info') {
    if (!isLoopback(req)) return endJson(res, 403, { error: 'only from this PC' });
    if (url.pathname === '/setup-info') {
      const urls = lanAddresses().map((ip) => `http://${ip}:${PORT}/?k=${config.token}`);
      return endJson(res, 200, {
        token: config.token,
        phoneUrls: urls,
        agentOnline: !!pickPrimary(),
        mode: browser ? 'browser' : 'userscript',
        browserFound: browser ? !!browser.findBrowser() : null,
      });
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

// Настоящую домашнюю сеть ставим первой, VPN и виртуалки — в конец: по этому адресу
// setup-страница рисует QR-код, и телефон должен попасть именно в Wi-Fi.
// Виртуальные адаптеры (VirtualBox, Hyper-V, WSL, VMware, Docker) выдают себя MAC-адресом,
// туннели — маской /30, а хост-онли сети — тем, что ПК в них сам шлюз (адрес .1).
const VIRTUAL_MAC = /^(0a:00:27|00:15:5d|00:50:56|00:05:69|00:0c:29|02:42|00:00:00:00:00:00)/i;

function rankAddress(i) {
  let score = 0;
  if (VIRTUAL_MAC.test(i.mac || '')) score += 4;
  if (/^255\.255\.255\.(252|254|255)$/.test(i.netmask || '')) score += 4;
  if (i.address.endsWith('.1')) score += 2;
  if (!i.address.startsWith('192.168.')) score += i.address.startsWith('10.') ? 1 : 2;
  return score;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i);
  }
  return out.sort((a, b) => rankAddress(a) - rankAddress(b)).map((i) => i.address);
}

function startServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('ошибка: ' + e.message);
      endJson(res, 500, { error: e.message });
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.log(`Порт ${PORT} уже занят: либо VK Remote уже запущен, либо порт занят другой программой.`);
    else console.log('Не удалось запустить сервер: ' + e.message);
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\nVK Remote запущен. Открой на телефоне (тот же Wi-Fi):\n');
    for (const ip of lanAddresses()) console.log(`   http://${ip}:${PORT}/?k=${config.token}`);
    console.log(`\nНа ПК: http://127.0.0.1:${PORT}/?k=${config.token}`);
    console.log('Ключ лежит в config.json — удали файл, чтобы сгенерировать новый.\n');
    if (!process.env.VK_REMOTE_BG) console.log('Не закрывай это окно, пока пользуешься пультом.\n');
    if (process.env.VK_REMOTE_OPEN) openUrl(`http://127.0.0.1:${PORT}/setup`);
    if (browser) browser.watch();
    startTray();
  });
}

function qrGif(text) {
  const qrcode = require('./public/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(8, 16).replace(/^data:image\/gif;base64,/, '');
}

// Значок в трее живёт, пока работает сервер: сам выходит, если сервер пропал, а сервер
// перезапускает значок, если тот перестал опрашивать (например, упал PowerShell).
function startTray() {
  if (process.platform !== 'win32' || !browser) return;
  const spawnTray = () => {
    tray.spawns++;
    tray.lastSeen = Date.now();
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'tray.ps1'),
        '-Port', String(PORT), '-Icon', path.join(__dirname, 'public', 'icon.ico')],
      // Рабочая папка — данные, а не программа: иначе Windows не даст установщику заменить папку app.
      { windowsHide: true, stdio: 'ignore', cwd: DATA_DIR }
    );
    tray.child = child;
    child.on('error', (e) => log('значок в трее: ' + e.message));
  };
  spawnTray();
  setInterval(() => {
    if (Date.now() - tray.lastSeen > 20_000 && tray.spawns < 5) {
      log('значок в трее не отвечает — перезапускаю');
      spawnTray();
    }
  }, 30_000).unref();
}

function openUrl(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
}

// ---------- служебные режимы для bat-файлов ----------
// Ходим на 127.0.0.1 напрямую через http, без curl и системных прокси.
function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/ping', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body.includes('vk-remote')));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function stopServer() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/shutdown', method: 'POST', headers: { 'X-VKR': '1' }, timeout: 3000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Запускаем копию себя отдельным процессом без окна; весь её вывод (и ошибки) — в runtime/server.log.
async function startInBackground() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const fd = fs.openSync(LOG_PATH, 'w');
  const child = spawn(process.execPath, [__filename], {
    cwd: DATA_DIR, // не папка программы: её должно быть можно удалить при обновлении
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, VK_REMOTE_BG: '1', VK_REMOTE_DATA: DATA_DIR },
  });
  let exitCode = null;
  child.on('exit', (code) => (exitCode = code));
  child.on('error', (e) => { fs.appendFileSync(LOG_PATH, 'spawn: ' + e.message + '\n'); exitCode = -1; });
  child.unref();

  for (let i = 0; i < 20 && exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ping()) {
      console.log('VK Remote запущен в фоне.');
      return true;
    }
  }
  console.log(exitCode === null ? 'Сервер не ответил за 10 секунд.' : `Сервер завершился с кодом ${exitCode}.`);
  return false;
}

function localPost(p) {
  return fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'X-VKR': '1' } })
    .then((r) => r.json())
    .catch(() => null);
}

// Ярлык «Управлять музыкой через ВК»: поднять сервер в фоне, открыть окно VK и страницу с QR.
async function openAll() {
  process.env.VK_REMOTE_CDP = '1';
  if (!(await ping()) && !(await startInBackground())) {
    if (process.platform === 'win32') execFile('notepad', [LOG_PATH]);
    return false;
  }
  await localPost('/local/launch');
  const r = await localPost('/local/show-qr');
  if (!r || !r.shown) openUrl(`http://127.0.0.1:${PORT}/setup`);
  return true;
}

// Автозапуск при входе в Windows: только сервер и значок в трее, без окна ВК и без страниц.
// Окно ВК откроется по ярлыку, из меню значка или кнопкой на телефоне.
async function autostart() {
  process.env.VK_REMOTE_CDP = '1';
  return (await ping()) || startInBackground();
}

// Разовая настройка после скачивания: брандмауэр (одно окно «Да» от Windows), ярлык, первый запуск.
async function installAll() {
  const { installFirewall, installShortcut, SHORTCUT_NAME } = require('./install');
  fs.mkdirSync(path.join(DATA_DIR, 'runtime'), { recursive: true });
  const opts = { dataDir: DATA_DIR, appDir: __dirname, nodePath: process.execPath };
  console.log('Разрешаю пульту доступ из домашней сети (Windows спросит «Разрешить изменения?» — нажми «Да»)...');
  console.log((await installFirewall(opts)) ? '  готово' : '  пропущено — Windows спросит про брандмауэр позже, нажми «Разрешить»');
  console.log(`Создаю ярлык «${SHORTCUT_NAME}» на рабочем столе и автозапуск при входе в Windows...`);
  console.log((await installShortcut(opts)) ? '  готово' : '  не получилось');
  await stopServer(); // если работала старая версия — перезапустим уже новую
  await new Promise((r) => setTimeout(r, 500));
  return openAll();
}

const MODES = {
  '--ping': ping,
  '--stop': stopServer,
  '--background': startInBackground,
  '--open': openAll,
  '--install': installAll,
  '--autostart': autostart,
};
const mode = process.argv.slice(2).find((a) => MODES[a]);
if (mode) MODES[mode]().then((ok) => process.exit(ok ? 0 : 1));
else startServer();
