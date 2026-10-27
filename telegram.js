// Telegram-бот пульта: сообщение «Сейчас играет», которое обновляется при смене трека.
// Работает откуда угодно — ПК сам опрашивает Telegram, входящих подключений нет.
//
// Кто есть кто:
//   хозяин     — человек за этим ПК: видит трек и управляет кнопками ⏮ ⏯ ⏭. Свободного бота
//                забирает первый «Старт»; перепривязать — ссылкой с кодом из QR на странице настройки.
//   подписчики — видят, что играет, без управления, и кнопку «Найти в VK», чтобы добавить трек себе.
//                Подписка — только по ссылке t.me/<бот>?start=w<код> (код знает тот, кто собрал
//                установщик); список подписчиков виден хозяину на странице настройки.
//
// Один бот работает на одном ПК: Telegram отдаёт обновления бота только одному получателю, второй
// ПК с тем же ключом получил бы ошибку 409. Смотреть сообщения бота могут сколько угодно людей.

'use strict';
const crypto = require('crypto');

const API = process.env.VK_REMOTE_TG_API || 'https://api.telegram.org'; // подмена — только для тестов
const POLL_TIMEOUT_S = 25;
const UPDATE_DEBOUNCE_MS = 1500;

const escape = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const nameOf = (from = {}) =>
  from.username ? '@' + from.username : [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Разовый запрос к Bot API (используется и для проверки ключа при сборке установщика для друга).
async function botCall(token, method, params = {}, timeoutS = 15) {
  const r = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutS * 1000),
  });
  const j = await r.json().catch(() => ({ ok: false, description: 'bad response' }));
  if (!j.ok) {
    const err = new Error(j.description || 'telegram error');
    err.code = j.error_code;
    throw err;
  }
  return j.result;
}

function createTelegram({ config, saveConfig, getNowPlaying, runCommand, history, log }) {
  let me = null;           // { username } бота
  let status = 'off';      // off | connecting | ok | conflict | bad-token | network
  let stopped = false;
  let updateTimer = null;
  let wake = null;         // будит цикл, когда на странице настройки ввели ключ
  const lastShown = new Map(); // chatId -> что сейчас показано в его сообщении

  const tg = () => config.telegram || (config.telegram = {});
  const watchers = () => tg().watchers || (tg().watchers = []);
  const call = (method, params) => botCall(tg().token, method, params, POLL_TIMEOUT_S + 10);

  function code(field) {
    if (!tg()[field]) {
      tg()[field] = crypto.randomBytes(4).toString('hex');
      saveConfig();
    }
    return tg()[field];
  }

  function render(forOwner) {
    const np = getNowPlaying() || {};
    let text;
    if (!np.title) text = '🎵 Пока ничего не играет';
    else if (np.ad) text = `📢 Реклама VK — дальше:\n<b>${escape(np.title)}</b>\n${escape(np.artist)}`;
    else text = `${np.playing ? '▶️ Сейчас играет' : '⏸ На паузе'}:\n<b>${escape(np.title)}</b>\n${escape(np.artist)}`;
    const rows = [];
    if (forOwner) {
      rows.push([
        { text: '⏮', callback_data: 'prev' },
        { text: np.playing ? '⏸' : '▶️', callback_data: 'toggle' },
        { text: '⏭', callback_data: 'next' },
      ]);
    }
    const extra = [];
    if (np.title && !np.ad) {
      // Поиск трека в VK: на телефоне откроется приложение VK, там трек добавляется себе обычным «+».
      const q = [np.artist, np.title].filter(Boolean).join(' ');
      extra.push({ text: '🔍 Найти в VK', url: 'https://vk.com/audio?q=' + encodeURIComponent(q) });
    }
    if (history) extra.push({ text: '📜 Что играло', callback_data: 'log' });
    if (extra.length) rows.push(extra);
    return { text, keyboard: { inline_keyboard: rows } };
  }

  // Журнал: последние n треков со временем начала, по дням. Последний — с пометкой, если играет сейчас.
  function renderLog(n) {
    const items = history ? history.recent(n) : [];
    if (!items.length) return '📜 Журнал пока пуст — здесь появятся треки, когда что-нибудь заиграет.';
    const np = getNowPlaying() || {};
    const day = (t) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const time = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const lines = ['📜 <b>Что играло</b>'];
    let lastDay = null;
    items.forEach((e, i) => {
      if (day(e.t) !== lastDay) {
        lastDay = day(e.t);
        lines.push('', `<b>${escape(lastDay)}</b>`);
      }
      const current = i === items.length - 1 && np.title === e.title;
      const mark = current ? (np.playing ? ' ▶️' : ' ⏸') : e.skipped ? ' <i>(пропущен)</i>' : '';
      lines.push(`${time(e.t)}  ${escape(e.artist ? e.artist + ' — ' : '')}${escape(e.title)}${mark}`);
    });
    // Ограничение Telegram — 4096 символов: при переполнении отрезаем самые старые строки.
    let text = lines.join('\n');
    while (text.length > 4000 && lines.length > 3) {
      lines.splice(2, 1);
      text = lines.join('\n');
    }
    return text;
  }

  const sendLog = (chatId, n = 25) =>
    call('sendMessage', { chat_id: chatId, text: renderLog(Math.min(100, Math.max(1, n))), parse_mode: 'HTML', disable_notification: true });

  // Все, кому показываем сообщение: хозяин и подписчики. holder — объект, где хранится messageId.
  function targets() {
    const list = [];
    if (tg().chatId) list.push({ chatId: tg().chatId, owner: true, holder: tg() });
    for (const w of watchers()) list.push({ chatId: w.chatId, owner: false, holder: w });
    return list;
  }

  // Обновляем сообщение на месте; если его удалили или оно слишком старое — присылаем новое.
  async function showTo(t, fresh) {
    const { text, keyboard } = render(t.owner);
    const key = text + JSON.stringify(keyboard);
    if (!fresh && lastShown.get(t.chatId) === key) return;
    try {
      if (!fresh && t.holder.messageId) {
        await call('editMessageText', {
          chat_id: t.chatId, message_id: t.holder.messageId, text, parse_mode: 'HTML', reply_markup: keyboard,
        });
      } else {
        const m = await call('sendMessage', {
          chat_id: t.chatId, text, parse_mode: 'HTML', reply_markup: keyboard, disable_notification: true,
        });
        t.holder.messageId = m.message_id;
        saveConfig();
      }
      lastShown.set(t.chatId, key);
    } catch (e) {
      if (/not modified/i.test(e.message)) { lastShown.set(t.chatId, key); return; }
      if (!fresh && /message to edit not found|can't be edited|MESSAGE_ID_INVALID/i.test(e.message)) return showTo(t, true);
      if (e.code === 403) {
        // Человек заблокировал бота — больше ему не пишем.
        log('бот: чат закрыт ' + t.chatId);
        if (t.owner) tg().chatId = null;
        else tg().watchers = watchers().filter((w) => w.chatId !== t.chatId);
        saveConfig();
        return;
      }
      log('бот: не удалось обновить сообщение — ' + e.message);
    }
  }

  async function showStatus({ fresh = false, only = null } = {}) {
    if (status !== 'ok') return;
    for (const t of targets()) {
      if (only === null || t.chatId === only) await showTo(t, fresh);
    }
  }

  // Сервер зовёт это при каждом новом состоянии плеера; шлём не чаще раза в полторы секунды.
  function onState() {
    if (updateTimer) return;
    updateTimer = setTimeout(() => { updateTimer = null; showStatus(); }, UPDATE_DEBOUNCE_MS);
  }

  const say = (chatId, text) => call('sendMessage', { chat_id: chatId, text });

  async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const isWatcher = watchers().some((w) => w.chatId === chatId);
    const m = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);

    // Подписка по ссылке с кодом подписчика — проверяем первой, чтобы подписчик не стал хозяином.
    if (m && m[1] && tg().watchCode && m[1] === 'w' + tg().watchCode) {
      if (chatId === tg().chatId) return say(chatId, 'Ты и так хозяин этого бота.');
      if (!isWatcher) {
        watchers().push({ chatId, name: nameOf(msg.from), messageId: null });
        saveConfig();
        log('бот: новый подписчик ' + chatId);
      }
      await say(chatId, 'Готово! Здесь будет видно, что сейчас играет. Понравился трек — кнопка «Найти в VK» под сообщением. Отписаться — /stop.');
      return showStatus({ fresh: true, only: chatId });
    }

    // Хозяин: свободного бота забирает первый «Старт» (не подписчик); занятого — только код из QR.
    if (m && ((!tg().chatId && !isWatcher) || (m[1] && m[1] === code('pairCode')))) {
      tg().chatId = chatId;
      tg().chatName = nameOf(msg.from);
      tg().messageId = null;
      tg().watchers = watchers().filter((w) => w.chatId !== chatId);
      saveConfig();
      log('бот: привязан хозяин ' + chatId);
      await say(chatId, 'Готово! Этот бот показывает, что играет в ВК на твоём компьютере, и переключает треки.');
      return showStatus({ fresh: true, only: chatId });
    }
    if (m && m[1]) return say(chatId, 'Ссылка не подошла. Попроси новую у того, кто настраивал пульт.');

    if (chatId === tg().chatId || isWatcher) {
      if (/^\/stop\b/.test(text) && isWatcher) {
        tg().watchers = watchers().filter((w) => w.chatId !== chatId);
        saveConfig();
        return say(chatId, 'Отписал. Вернуться — по той же ссылке.');
      }
      const lg = text.match(/^\/log(?:@\w+)?(?:\s+(\d+))?/);
      if (lg) return sendLog(chatId, lg[1] ? Number(lg[1]) : 25);
      if (/^\/(now|start)\b/.test(text)) return showStatus({ fresh: true, only: chatId });
      return;
    }
    return say(chatId, tg().chatId ? 'Этот бот привязан к другому человеку.' : 'Пульт на компьютере пока не настроен.');
  }

  async function handleUpdate(u) {
    if (u.message && typeof u.message.text === 'string') return handleMessage(u.message);
    if (u.callback_query) {
      const q = u.callback_query;
      const chatId = q.message && q.message.chat.id;
      const fromOwner = chatId === tg().chatId;
      // Журнал можно смотреть и хозяину, и подписчикам.
      if (q.data === 'log' && (fromOwner || watchers().some((w) => w.chatId === chatId))) {
        await call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
        return sendLog(chatId);
      }
      const type = fromOwner && ['prev', 'toggle', 'next'].includes(q.data) ? q.data : null;
      let answer = 'Управлять может только хозяин пульта';
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
          showStatus();
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
      config.telegram = { token: token || null };
      me = null;
      lastShown.clear();
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

  function removeWatchers() {
    tg().watchers = [];
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
      watchers: watchers().map((w) => w.name || 'чат ' + w.chatId),
      link: me ? `https://t.me/${me.username}?start=${code('pairCode')}` : null,
    };
  }

  loop();
  return { onState, setToken, unbind, removeWatchers, info, stop: () => (stopped = true) };
}

module.exports = { createTelegram, botCall };
