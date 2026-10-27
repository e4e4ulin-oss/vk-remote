// Telegram-бот пульта: одно сообщение «Сейчас играет», которое обновляется при смене трека,
// и кнопки ⏮ ⏯ ⏭ под ним. Работает откуда угодно — ПК сам опрашивает Telegram, входящих подключений нет.
//
// Один бот — один ПК: Telegram отдаёт обновления бота только одному получателю, второй ПК с тем же
// ключом получил бы ошибку 409. Бот слушается только привязанного чата. Пока бот ни к кому не
// привязан, его забирает первый, кто нажмёт «Старт» (так проще всего для человека); перепривязать
// к другому телефону — по ссылке t.me/<бот>?start=<код> со страницы настройки.

'use strict';
const crypto = require('crypto');

const API = process.env.VK_REMOTE_TG_API || 'https://api.telegram.org'; // подмена — только для тестов
const POLL_TIMEOUT_S = 25;
const UPDATE_DEBOUNCE_MS = 1500;

function createTelegram({ config, saveConfig, getNowPlaying, runCommand, log }) {
  let me = null;           // { username, first_name } бота
  let status = 'off';      // off | connecting | ok | conflict | bad-token | network
  let stopped = false;
  let lastShown = '';
  let updateTimer = null;
  let wake = null; // будит цикл, когда на странице настройки ввели ключ

  const tg = () => config.telegram || (config.telegram = {});

  async function call(method, params = {}) {
    const r = await fetch(`${API}/bot${tg().token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000),
    });
    const j = await r.json().catch(() => ({ ok: false, description: 'bad response' }));
    if (!j.ok) {
      const err = new Error(j.description || 'telegram error');
      err.code = j.error_code;
      throw err;
    }
    return j.result;
  }

  function pairCode() {
    if (!tg().pairCode) {
      tg().pairCode = crypto.randomBytes(4).toString('hex');
      saveConfig();
    }
    return tg().pairCode;
  }

  const escape = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

  function render() {
    const np = getNowPlaying() || {};
    let text;
    if (!np.title) text = '🎵 Пока ничего не играет';
    else if (np.ad) text = `📢 Реклама VK — дальше:\n<b>${escape(np.title)}</b>\n${escape(np.artist)}`;
    else text = `${np.playing ? '▶️ Сейчас играет' : '⏸ На паузе'}:\n<b>${escape(np.title)}</b>\n${escape(np.artist)}`;
    const keyboard = {
      inline_keyboard: [[
        { text: '⏮', callback_data: 'prev' },
        { text: np.playing ? '⏸' : '▶️', callback_data: 'toggle' },
        { text: '⏭', callback_data: 'next' },
      ]],
    };
    return { text, keyboard };
  }

  // Обновляем сообщение на месте; если его удалили или оно слишком старое — присылаем новое.
  async function showStatus({ fresh = false } = {}) {
    const chatId = tg().chatId;
    if (!chatId || status !== 'ok') return;
    const { text, keyboard } = render();
    const key = text + JSON.stringify(keyboard);
    if (!fresh && key === lastShown) return;
    try {
      if (!fresh && tg().messageId) {
        await call('editMessageText', {
          chat_id: chatId, message_id: tg().messageId, text, parse_mode: 'HTML', reply_markup: keyboard,
        });
      } else {
        const m = await call('sendMessage', {
          chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard, disable_notification: true,
        });
        tg().messageId = m.message_id;
        saveConfig();
      }
      lastShown = key;
    } catch (e) {
      if (/not modified/i.test(e.message)) { lastShown = key; return; }
      if (!fresh && /message to edit not found|can't be edited|MESSAGE_ID_INVALID/i.test(e.message)) return showStatus({ fresh: true });
      if (e.code === 403) { log('бот: чат закрыт пользователем'); tg().chatId = null; saveConfig(); return; }
      log('бот: не удалось обновить сообщение — ' + e.message);
    }
  }

  // Сервер зовёт это при каждом новом состоянии плеера; шлём не чаще раза в полторы секунды.
  function onState() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => { updateTimer = null; showStatus(); }, UPDATE_DEBOUNCE_MS);
  }

  async function handleUpdate(u) {
    if (u.message && typeof u.message.text === 'string') {
      const chatId = u.message.chat.id;
      const text = u.message.text.trim();
      const m = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
      // Привязка: свободного бота забирает первый «Старт»; занятого — только по коду из QR.
      if (m && (!tg().chatId || m[1] === pairCode())) {
        const from = u.message.from || {};
        tg().chatId = chatId;
        tg().chatName = from.username ? '@' + from.username : [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
        tg().messageId = null;
        saveConfig();
        log('бот: привязан чат ' + chatId);
        await call('sendMessage', { chat_id: chatId, text: 'Готово! Этот бот теперь показывает, что играет в ВК на твоём компьютере, и переключает треки.' });
        return showStatus({ fresh: true });
      }
      if (m && m[1] && chatId !== tg().chatId) {
        return call('sendMessage', { chat_id: chatId, text: 'Код не подошёл. Отсканируй QR-код бота на странице настройки пульта на компьютере.' });
      }
      if (chatId !== tg().chatId) {
        return call('sendMessage', { chat_id: chatId, text: 'Этот бот привязан к другому человеку.' });
      }
      if (/^\/(now|start)\b/.test(text)) return showStatus({ fresh: true });
      return;
    }
    if (u.callback_query) {
      const q = u.callback_query;
      const allowed = q.message && q.message.chat.id === tg().chatId;
      const type = allowed && ['prev', 'toggle', 'next'].includes(q.data) ? q.data : null;
      let answer = 'Этот бот привязан к другому человеку';
      if (type) {
        const r = await runCommand({ type });
        answer = r && r.ok ? '' : (r && r.error) || 'Не получилось';
      }
      await call('answerCallbackQuery', { callback_query_id: q.id, text: answer }).catch(() => {});
      if (type) setTimeout(onState, 800);
    }
  }

  async function loop() {
    let offset = 0;
    while (!stopped) {
      if (!tg().token) {
        status = 'off';
        await new Promise((r) => { wake = r; setTimeout(r, 3000); });
        continue;
      }
      try {
        if (!me) {
          status = 'connecting';
          me = await call('getMe');
          status = 'ok';
          log('бот подключён: @' + me.username);
          showStatus({ fresh: !tg().messageId });
        }
        const updates = await call('getUpdates', { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] });
        status = 'ok';
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u).catch((e) => log('бот: ' + e.message));
        }
      } catch (e) {
        if (e.code === 401 || e.code === 404) { status = 'bad-token'; me = null; await sleep(10000); }
        else if (e.code === 409) { status = 'conflict'; await sleep(10000); }
        else { status = 'network'; me = null; await sleep(5000); }
      }
    }
  }

  function setToken(token) {
    const t = tg();
    if (t.token !== token) {
      t.token = token || null;
      t.chatId = null;
      t.chatName = null;
      t.messageId = null;
      t.pairCode = null;
      me = null;
      status = token ? 'connecting' : 'off';
      saveConfig();
      if (wake) wake();
    }
  }

  function unbind() {
    tg().chatId = null;
    tg().chatName = null;
    tg().messageId = null;
    tg().pairCode = null;
    saveConfig();
  }

  function info() {
    const t = tg();
    return {
      enabled: !!t.token,
      status,
      bot: me ? me.username : null,
      bound: !!t.chatId,
      boundTo: t.chatId ? t.chatName || 'чат ' + t.chatId : null,
      link: me ? `https://t.me/${me.username}?start=${pairCode()}` : null,
    };
  }

  loop();
  return { onState, setToken, unbind, info, stop: () => (stopped = true) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { createTelegram };
