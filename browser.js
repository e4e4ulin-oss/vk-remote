// Режим «без расширений»: сервер сам открывает отдельное окно браузера (Яндекс / Chrome / Edge)
// с собственным профилем и включённым протоколом отладки (CDP) и внедряет туда тот же агент,
// что и юзерскрипт Tampermonkey. Связь агента с сервером идёт через CDP-binding, а не через сеть:
// страница vk.com не делает запросов на localhost, поэтому ей не мешают ни расширения, ни политики браузера.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const CDP_PORT = Number(process.env.VK_REMOTE_CDP_PORT || 27614);
const VK_URL = process.env.VK_REMOTE_VK_URL || 'https://vk.com/audio';
const VK_HOST_RE = /(^|\.)vk\.(com|ru)$/;
// Яндекс в новом профиле открывает рядом с VK свои стартовые вкладки — закрываем их,
// но только сразу после нашего запуска и только служебные, чтобы не трогать вкладки человека.
const STARTUP_JUNK_RE = /^(chrome|browser|yabrowser):\/\/|yandex\.(ru|com)\/portal\/ntp/i;
const STARTUP_CLEANUP_MS = 60_000;
const LAUNCH_COOLDOWN_MS = 5_000; // пока браузер стартует, повторный запуск открыл бы второе окно

function createBrowserControl({ dataDir, appDir, serverPort, log, browserPath, onDisconnect }) {
  const profileDir = path.join(dataDir, 'browser-profile');
  // Номер этого запуска сервера. Регистрация скрипта в окне переживает перезапуск сервера, и после
  // обновления в странице оказались бы и старый, и новый агент. Сервер отвечает только агенту своего
  // запуска — старые замолкают без перезагрузки страницы (музыка не прерывается).
  const RUN_ID = crypto.randomBytes(6).toString('hex');
  let lastLaunchAt = 0;
  let connected = false;

  function candidates() {
    const env = process.env;
    const local = env.LOCALAPPDATA || '';
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      process.env.VK_REMOTE_BROWSER,
      browserPath,
      path.join(local, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
      path.join(pf, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
      path.join(pf86, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
  }

  function findBrowser() {
    return candidates().find((p) => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    }) || null;
  }

  async function cdpJson(p, method = 'GET') {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}${p}`, { method, signal: AbortSignal.timeout(2000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  const isVkPage = (t) => {
    if (t.type !== 'page') return false;
    try { return VK_HOST_RE.test(new URL(t.url).hostname) || t.url.startsWith(VK_URL); } catch { return false; }
  };

  // Окно VK открыто? Если браузер жив, но вкладки VK нет (Яндекс любит оставаться в фоне) — открываем её.
  // Если браузер не запущен — запускаем.
  async function ensureBrowser() {
    const list = await cdpJson('/json/list');
    if (list) {
      if (!list.some(isVkPage)) await cdpJson('/json/new?' + VK_URL, 'PUT');
      return { ok: true };
    }
    if (Date.now() - lastLaunchAt < LAUNCH_COOLDOWN_MS) return { ok: true };
    const exe = findBrowser();
    if (!exe) return { ok: false, error: 'Не нашёл Яндекс Браузер, Chrome или Edge' };
    lastLaunchAt = Date.now();
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=http://127.0.0.1',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      ...(process.env.VK_REMOTE_BROWSER_ARGS ? process.env.VK_REMOTE_BROWSER_ARGS.split('|') : []),
      VK_URL,
    ];
    log(`открываю окно VK: ${exe}`);
    try {
      spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      return { ok: false, error: 'Не удалось запустить браузер: ' + e.message };
    }
    closeStartupTabs();
    return { ok: true };
  }

  async function closeStartupTabs() {
    const until = Date.now() + STARTUP_CLEANUP_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const list = await cdpJson('/json/list');
      if (!list || !list.some(isVkPage)) continue; // пока нет вкладки VK, не закрываем — окно бы закрылось
      for (const t of list) {
        if (t.type === 'page' && !isVkPage(t) && STARTUP_JUNK_RE.test(t.url)) await cdpJson('/json/close/' + t.id);
      }
    }
  }

  // Код, который выполняется в каждой странице окна: подменяет API Tampermonkey и запускает юзерскрипт.
  function agentSource() {
    const userscript = fs.readFileSync(path.join(appDir, 'vk-remote.user.js'), 'utf8');
    return `(function () {
  if (window.top !== window || window.__vkrRun === '${RUN_ID}' || !${VK_HOST_RE}.test(location.hostname)) return;
  if (typeof window.__vkrSend !== 'function') return;
  window.__vkrRun = '${RUN_ID}';
  const pending = new Map();
  let seq = 0;
  window.__vkrReply = (id, ok, text) => {
    const o = pending.get(id);
    if (!o) return;
    pending.delete(id);
    if (ok) o.onload && o.onload({ responseText: text });
    else o.onerror && o.onerror();
  };
  const unsafeWindow = window;
  const GM_xmlhttpRequest = (o) => {
    const id = ++seq;
    pending.set(id, o);
    window.__vkrSend(JSON.stringify({ id, run: '${RUN_ID}', method: o.method, url: o.url, data: o.data || null }));
  };
${userscript}
})();`;
  }

  // Запрос агента пересылаем самому серверу. Разрешены только адреса /agent/* этого сервера.
  async function relay(payload, send) {
    let req;
    try { req = JSON.parse(payload); } catch { return; }
    if (req.run !== RUN_ID) return; // агент от прошлого запуска сервера — не отвечаем, он замолкает
    const prefix = `http://127.0.0.1:${serverPort}/agent/`;
    let ok = false;
    let text = '';
    if (typeof req.url === 'string' && req.url.startsWith(prefix)) {
      try {
        const r = await fetch(req.url, {
          method: req.method === 'POST' ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: req.method === 'POST' ? req.data || '{}' : undefined,
        });
        text = await r.text();
        ok = true;
      } catch {}
    }
    send('Runtime.evaluate', { expression: `window.__vkrReply && window.__vkrReply(${Number(req.id)}, ${ok}, ${JSON.stringify(text)})` }).catch(() => {});
  }

  function attach(target) {
    return new Promise((resolve) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      let id = 0;
      const pending = new Map();
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          if (ws.readyState !== WebSocket.OPEN) return rej(new Error('closed'));
          const i = ++id;
          pending.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params }));
        });

      ws.onopen = async () => {
        try {
          const source = agentSource();
          await send('Runtime.enable');
          await send('Page.enable');
          await send('Runtime.addBinding', { name: '__vkrSend' });
          // Убираем регистрации прошлых запусков (их номера — небольшие числа по порядку),
          // иначе при перезагрузке страницы запускался бы и старый агент.
          await Promise.all(
            Array.from({ length: 50 }, (_, i) =>
              send('Page.removeScriptToEvaluateOnNewDocument', { identifier: String(i + 1) }).catch(() => {})
            )
          );
          await send('Page.addScriptToEvaluateOnNewDocument', { source });
          await send('Runtime.evaluate', { expression: source });
          connected = true;
          log('окно VK на связи');
        } catch (e) {
          log('не удалось подключиться к окну VK: ' + e.message);
          ws.close();
        }
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        } else if (m.method === 'Runtime.bindingCalled' && m.params.name === '__vkrSend') {
          relay(m.params.payload, send);
        }
      };
      ws.onclose = () => {
        if (connected) {
          log('окно VK закрыто');
          if (onDisconnect) onDisconnect();
        }
        connected = false;
        for (const p of pending.values()) p.rej(new Error('closed'));
        resolve();
      };
      ws.onerror = () => {};
    });
  }

  // Постоянно держим связь с окном VK: окно могут закрыть и открыть заново.
  async function watch() {
    for (;;) {
      const list = await cdpJson('/json/list');
      const target = list && list.find(isVkPage);
      if (target) await attach(target);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return { ensureBrowser, watch, findBrowser, isConnected: () => connected, profileDir };
}

module.exports = { createBrowserControl, CDP_PORT };
