// Журнал прослушанного: какой трек и во сколько начал играть. Хранится на ПК (history.json в папке
// данных), пишется, даже когда никто не смотрит в Telegram. Показывает его бот (кнопка «Что играло», /log).

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
    if (np.playing && (!same || restarted)) {
      entries.push({ t: Date.now(), title: np.title, artist: np.artist || '', listened: Math.round(pos) });
      save();
      return;
    }
    if (same && pos > (last.listened || 0)) {
      last.listened = Math.round(pos);
      save();
    }
  }

  function recent(n) {
    return entries.slice(-n).map((e) => ({ ...e, skipped: (e.listened || 0) < SKIPPED_S }));
  }

  return { onState, recent, count: () => entries.length };
}

module.exports = { createHistory, SKIPPED_S };
