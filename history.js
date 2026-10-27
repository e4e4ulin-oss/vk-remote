// Журнал прослушанного: какой трек, во сколько начал играть и сколько от него прослушано. Хранится на ПК
// (history.json в папке данных), пишется, даже когда никто не смотрит в Telegram. Бот показывает его
// по кнопке «Что играло» / командой /musiclog и дублирует в каналы-журналы (они видны и при выключенном ПК).

'use strict';
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 2000;
const SKIPPED_S = 30;          // прослушано меньше — помечаем «пропущен»
const SAVE_DEBOUNCE_MS = 5000;

function createHistory({ dataDir, log }) {
  const file = path.join(dataDir, 'history.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!Array.isArray(entries)) entries = [];
  let saveTimer = null;
  const listeners = [];
  // Подписчики узнают о начале нового трека и о том, что предыдущий закончился (уже с итоговыми цифрами).
  const emit = (started, finished) => listeners.forEach((fn) => { try { fn({ started, finished }); } catch (e) { log('журнал: ' + e.message); } });

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
      try { fs.writeFileSync(file, JSON.stringify(entries)); } catch (e) { log('журнал: ' + e.message); }
    }, SAVE_DEBOUNCE_MS);
  }

  // Зовётся при каждом состоянии плеера. Новая запись — когда начал играть другой трек или тот же
  // трек пошёл заново (позиция откатилась к началу). Реклама и пауза записей не создают.
  function onState(np) {
    if (!np || !np.title || np.ad) return;
    const last = entries[entries.length - 1];
    const pos = typeof np.position === 'number' ? np.position : 0;
    const same = last && last.title === np.title && last.artist === (np.artist || '');
    const restarted = same && pos + 10 < (last.listened || 0) && pos < 15;
    const duration = typeof np.duration === 'number' && np.duration > 0 ? Math.round(np.duration) : null;
    if (np.playing && (!same || restarted)) {
      const entry = { t: Date.now(), title: np.title, artist: np.artist || '', listened: Math.round(pos), duration };
      entries.push(entry);
      save();
      emit(entry, last && !last.done ? finish(last) : null);
      return;
    }
    if (same && pos > (last.listened || 0)) {
      last.listened = Math.round(pos);
      save();
    }
    if (same && duration && !last.duration) last.duration = duration;
  }

  function finish(e) {
    e.done = true;
    save();
    return e;
  }

  const percent = (e) => (e.duration ? Math.min(100, Math.round(((e.listened || 0) / e.duration) * 100)) : null);

  function recent(n) {
    return entries.slice(-n).map((e) => ({ ...e, percent: percent(e), skipped: (e.listened || 0) < SKIPPED_S }));
  }

  return {
    onState,
    recent,
    percent,
    save,
    subscribe: (fn) => listeners.push(fn),
    count: () => entries.length,
  };
}

module.exports = { createHistory, SKIPPED_S };
