// ==UserScript==
// @name         VK Remote — агент
// @namespace    vk-remote
// @version      0.4.3
// @description  Связывает вкладку vk.com с локальным сервером VK Remote, чтобы управлять музыкой с телефона
// @match        https://vk.com/*
// @match        https://vk.ru/*
// @run-at       document-start
// @noframes
// @sandbox      JavaScript
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @updateURL    http://127.0.0.1:27613/vk-remote.user.js
// @downloadURL  http://127.0.0.1:27613/vk-remote.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ----- настройки -----
  const SERVER = 'http://127.0.0.1:27613';
  const MY_MUSIC_PATH = '/audio';
  const SEARCH_PATH = (q) => '/audio?q=' + encodeURIComponent(q);
  // Раздел результатов поиска с треками самого пользователя («Моя музыка», «В моих аудиозаписях»…).
  const MY_SECTION_RE = /мо(я|ей|ю|и|их)\s+(музык|аудио|трек|плейлист)|в\s+моей|добавленн|my\s+music|your\s+music/i;
  // Заголовки разделов поиска у нынешнего VK («Мои треки», «Все треки», «Найдено в тексте»…).
  const VK_HEADING_SEL = '[data-testid^="AudioCatalog_BlockHeader"]';
  // Запасной вариант для другой вёрстки: h2/h3, role=heading или блоки *Header*/*Title*.
  const HEADING_SEL = 'h1,h2,h3,h4,[role="heading"],[data-testid*="header" i],[data-testid*="title" i],[class*="Header"],[class*="Title"]';
  // Селекторы строк с треками: старый дизайн VK, затем догадки для нового.
  const ROW_SELECTORS = [
    '.audio_row[data-audio]',
    '[data-testid="MusicTrackRow"]',
    '[data-testid*="track_row" i]',
    '[data-testid*="audio_row" i]',
    '[class*="AudioRow"]',
    '[class*="TrackRow"]',
  ];

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const AGENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // ----- перехват <audio>, которым играет VK -----
  // VK создаёт Audio() вне DOM, поэтому ловим элемент в момент play().
  let media = null;
  try {
    const proto = W.HTMLMediaElement.prototype;
    const origPlay = proto.play;
    proto.play = function () {
      if (!(this instanceof W.HTMLVideoElement)) media = this;
      return origPlay.apply(this, arguments);
    };
  } catch (e) {
    console.warn('[vk-remote] не удалось перехватить play()', e);
  }

  // ----- транспорт до сервера -----
  function request(method, path, body, timeout) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: SERVER + path + (path.includes('?') ? '&' : '?') + 'agent=' + AGENT_ID,
        headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        timeout: timeout || 10000,
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText || '{}')); } catch { resolve({}); }
        },
        onerror: () => reject(new Error('network')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }
  const post = (path, body) => request('POST', path, body).catch(() => null);
  const reportError = (message) => post('/agent/error', { message });

  // ----- плеер -----
  // Плеер VK опознаём по любому из знакомых методов: в нынешней версии playNext уже нет,
  // зато есть isPlaying/getCurrentProgressTime, и именно они дают честные статус и время.
  const PLAYER_METHODS = ['playNext', 'isPlaying', 'getCurrentProgressTime', 'getCurrentAudioLs'];

  function looksLikePlayer(o) {
    return !!o && PLAYER_METHODS.some((m) => typeof o[m] === 'function');
  }

  function ap() {
    if (looksLikePlayer(W.ap)) return W.ap;
    try {
      const got = typeof W.getAudioPlayer === 'function' ? W.getAudioPlayer() : null;
      if (looksLikePlayer(got)) return got;
    } catch {}
    return null;
  }

  // У элемента с position:fixed свойство offsetParent всегда null, а панель плеера VK
  // закреплена внизу экрана. Поэтому видимость проверяем по наличию прямоугольников.
  function visible(el) {
    return !!el && el.getClientRects().length > 0;
  }

  function clickButton(re) {
    const nodes = document.querySelectorAll('button, [role="button"], a, div[aria-label]');
    for (const n of nodes) {
      const label = (n.getAttribute('aria-label') || n.getAttribute('title') || '') + ' ' + (n.dataset.testid || '');
      if (re.test(label) && visible(n)) { n.click(); return true; }
    }
    return false;
  }

  // У нового плеера VK (vk.ru, 2026) подписи кнопок меняются, а data-testid держатся.
  // Значения взяты из diagnostics() на живой странице.
  const BTN_TESTIDS = {
    toggle: ['audio-player-controls-state-button', 'TopAudioPlayer_TogglePlayAction'],
    next: ['audio-player-controls-forward-button', 'TopAudioPlayer_ForwardAction'],
    prev: ['audio-player-controls-backward-button', 'TopAudioPlayer_BackwardAction'],
  };

  function clickTestId(names) {
    for (const name of names) {
      const el = document.querySelector('[data-testid="' + name + '"]');
      if (visible(el)) { el.click(); return true; }
    }
    return false;
  }

  const NEXT_RE = /следующ|next/i;
  const PREV_RE = /предыдущ|previous|prev\b/i;
  const PLAY_RE = /воспроизв|продолж|пауз|play|pause/i;
  // Медиаклавиша в Windows одна на play и pause: жмём её, только если за это время звук точно
  // не сменил состояние. Меньшая пауза рискует снова поставить на паузу медленно грузящийся трек.
  const MEDIAKEY_FALLBACK_MS = 1000;

  const player = {
    isPlaying() {
      // Перехваченный <audio> врёт: новый плеер VK подменяет элемент на каждом треке,
      // поэтому сначала спрашиваем сам VK и mediaSession, а элемент оставляем на крайний случай.
      const p = ap();
      if (p && typeof p.isPlaying === 'function') return !!p.isPlaying();
      if (p && typeof p._isPlaying === 'boolean') return p._isPlaying;
      const ms = W.navigator.mediaSession;
      if (ms && (ms.playbackState === 'playing' || ms.playbackState === 'paused')) return ms.playbackState === 'playing';
      if (media) return !media.paused;
      return false;
    },
    async play() {
      if (this.isPlaying()) return true;
      const p = ap();
      try {
        // Своя кнопка плеера — единственный надёжный способ: методов play/pause у нового VK нет,
        // а перехваченный <audio> устаревает, потому что VK подменяет элемент на каждом треке.
        if (!clickTestId(BTN_TESTIDS.toggle) && !clickButton(PLAY_RE)) {
          if (p && typeof p.play === 'function') await p.play();
          else if (media) await media.play();
        }
      } catch (e) {
        // NotAllowedError — браузер не разрешил звук; разбираемся ниже.
      }
      // Пока во вкладке VK не кликали мышью, браузер запрещает запускать звук программно.
      // Нажатие медиаклавиши идёт мимо этого запрета, поэтому пробуем её, если звук не пошёл.
      await sleep(MEDIAKEY_FALLBACK_MS);
      if (!this.isPlaying()) await post('/agent/mediakey', { key: 'play' });
      return true;
    },
    async pause() {
      if (!this.isPlaying()) return true;
      const p = ap();
      try {
        if (!clickTestId(BTN_TESTIDS.toggle) && !clickButton(PLAY_RE)) {
          if (p && typeof p.pause === 'function') p.pause();
          else if (media) media.pause();
        }
      } catch (e) {}
      await sleep(MEDIAKEY_FALLBACK_MS);
      if (this.isPlaying()) await post('/agent/mediakey', { key: 'pause' });
      return true;
    },
    toggle() { return this.isPlaying() ? this.pause() : this.play(); },
    next() {
      const p = ap();
      if (p && typeof p.playNext === 'function') return p.playNext();
      return clickTestId(BTN_TESTIDS.next) || clickButton(NEXT_RE) || post('/agent/mediakey', { key: 'next' });
    },
    prev() {
      const p = ap();
      if (p && typeof p.playPrev === 'function') return p.playPrev();
      return clickTestId(BTN_TESTIDS.prev) || clickButton(PREV_RE) || post('/agent/mediakey', { key: 'prev' });
    },
    setVolume(v) {
      v = Math.max(0, Math.min(1, Number(v)));
      const p = ap();
      if (p && typeof p.setVolume === 'function') p.setVolume(v);
      if (media) media.volume = v;
    },
    seek(sec) {
      const p = ap();
      if (media && isFinite(media.duration)) media.currentTime = Math.max(0, Math.min(media.duration, Number(sec)));
      else if (p && typeof p.seek === 'function' && p.getCurrentAudio) p.seek(Number(sec) / (p.getCurrentAudio()[5] || 1));
    },
  };

  function nowPlaying() {
    const meta = W.navigator.mediaSession && W.navigator.mediaSession.metadata;
    let title = meta ? meta.title : '';
    let artist = meta ? meta.artist : '';
    let cover = meta && meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : '';
    const p = ap();
    // Нынешний VK зовёт этот метод getCurrentAudioLs; getCurrentAudio оставлен для старого.
    const cur = p && typeof p.getCurrentAudioLs === 'function' ? p.getCurrentAudioLs()
      : p && typeof p.getCurrentAudio === 'function' ? p.getCurrentAudio() : null;
    if (!title && Array.isArray(cur)) { title = decode(cur[3]); artist = decode(cur[4]); }
    // Время и длительность спрашиваем у плеера: перехваченный <audio> у нового VK живёт
    // недолго (элемент подменяется на каждом треке), и тогда прогресс на телефоне замирает.
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const call = (m) => { try { return p && typeof p[m] === 'function' ? p[m]() : null; } catch { return null; } };
    const posFromAp = num(call('getCurrentProgressTime'));
    const durFromAp = num(call('getCurrentDuration'));
    // Без подписки VK крутит рекламу перед треком: плеер говорит «играет», а время трека стоит на нуле.
    // Прямой флаг — ap.ads._isActive (найден на живом VK); счётчик рекламы — запасной признак.
    const adTime = num(call('getCurrentAdProgressTime'));
    const adActive = !!(p && p.ads && p.ads._isActive === true);
    return {
      title: title || '',
      artist: artist || '',
      cover: cover || '',
      playing: !!player.isPlaying(),
      ad: adActive || (adTime !== null && adTime > 0),
      position: posFromAp !== null ? posFromAp / 1000 : media ? media.currentTime : null,
      duration: durFromAp !== null ? durFromAp : media && isFinite(media.duration) ? media.duration : null,
      volume: media ? media.volume : num(p && p._userVolume),
      mode: p ? 'vk-api' : media ? 'audio-element' : 'dom',
    };
  }

  function decode(s) {
    const t = document.createElement('textarea');
    t.innerHTML = String(s || '');
    return t.value;
  }

  // ----- списки треков -----
  let rows = [];

  function findRowElements() {
    for (const sel of ROW_SELECTORS) {
      const found = [...document.querySelectorAll(sel)].filter(visible);
      if (found.length) return found;
    }
    return [];
  }

  function parseRow(el) {
    if (el.dataset.audio) {
      try {
        const d = JSON.parse(el.dataset.audio);
        return { title: decode(d[3]), artist: decode(d[4]), duration: Number(d[5]) || null };
      } catch {}
    }
    // Новый дизайн: берём строки текста строки трека.
    const lines = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const durIdx = lines.findIndex((s) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(s));
    const dur = durIdx >= 0 ? lines.splice(durIdx, 1)[0] : null;
    const toSec = (s) => s.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
    return { title: lines[0] || '?', artist: lines[1] || '', duration: dur ? toSec(dur) : null };
  }

  const isRow = (el) => ROW_SELECTORS.some((sel) => el.matches(sel));
  const hasRows = (el) => ROW_SELECTORS.some((sel) => el.querySelector(sel));

  const firstLine = (el) => (el.innerText || '').trim().split('\n')[0].trim();

  // Заголовок раздела внутри el. Сначала настоящие заголовки VK, потом общий поиск — но без длительностей
  // треков (они у VK в h4) и без длинных текстов вроде баннера подписки.
  function headingText(el) {
    const vk = el.matches(VK_HEADING_SEL) ? el : el.querySelector(VK_HEADING_SEL);
    if (vk) {
      // В заголовке рядом с названием бывает ссылка «Показать все» — её в название раздела не берём.
      const copy = vk.cloneNode(true);
      copy.querySelectorAll('a, button, [role="button"], [data-testid*="Action"]').forEach((x) => x.remove());
      return copy.textContent.trim().split('\n')[0].replace(/\s+/g, ' ').trim() || firstLine(vk) || null;
    }
    const candidates = el.matches(HEADING_SEL) ? [el] : el.querySelectorAll(HEADING_SEL);
    for (const h of candidates) {
      const text = firstLine(h);
      if (text && text.length <= 40 && !/^\d{1,2}:\d{2}/.test(text) && !/₽|\$|€/.test(text)) return text;
    }
    return null;
  }

  // Раздел трека — ближайший заголовок выше по странице. Поднимаемся от строки и на каждом уровне
  // смотрим предыдущих соседей; блок с другими треками — это чужой раздел, тогда идём уровнем выше.
  function sectionOf(el, cache) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (cache.has(node)) return cache.get(node);
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (isRow(sib)) continue;
        if (hasRows(sib)) break;
        const text = headingText(sib);
        if (text) {
          cache.set(node, text);
          return text;
        }
      }
    }
    return '';
  }

  function scrape() {
    const els = findRowElements();
    rows = els;
    const cache = new Map();
    return els.map((el, i) => ({ index: i, section: sectionOf(el, cache), ...parseRow(el) }));
  }

  async function sendList(id, title) {
    const tracks = scrape();
    // В тексте ошибки — адрес, который увидел агент: если запрос побился по дороге (кодировка),
    // это сразу заметно.
    let addr = location.pathname + location.search;
    try { addr = decodeURIComponent(addr); } catch {}
    const where = id === 'search' ? ` (адрес: ${addr})` : '';
    await post('/agent/list', {
      id,
      title,
      tracks,
      error: tracks.length ? null : 'Не нашёл треков на странице' + where + '. Пришли диагностику — подстрою селекторы.',
    });
  }

  async function goAndWait(url) {
    const prevFirst = findRowElements()[0];
    const prevUrl = location.href;
    navigate(url);
    await waitForRows(prevFirst, prevUrl);
  }

  // Поиск только по своей музыке: берём раздел «Моя музыка» из обычного поиска VK — он ищет
  // по всей библиотеке, а не только по загруженной на странице части.
  async function searchMine(q) {
    const title = 'Моя музыка: ' + q;
    await goAndWait(SEARCH_PATH(q));
    const all = scrape();
    const mine = all.filter((t) => MY_SECTION_RE.test(t.section));
    if (mine.length) {
      return post('/agent/list', {
        id: 'my',
        title,
        tracks: mine.map((t) => ({ ...t, section: '' })),
        // Раздел «Мои треки» в поиске VK обрезан до 20 и кнопки «Показать все» у него нет.
        note: mine.length >= 20 ? 'VK показывает только первые 20 совпадений — уточни запрос, если нужного нет' : null,
      });
    }
    // Если VK так и не показал раздела «Моя музыка», ищем среди загруженных треков своей страницы.
    const sections = new Set(all.map((t) => t.section).filter(Boolean));
    await goAndWait(MY_MUSIC_PATH);
    const needle = q.toLowerCase();
    const found = scrape().filter((t) => (t.title + ' ' + t.artist).toLowerCase().includes(needle));
    return post('/agent/list', {
      id: 'my',
      title,
      tracks: found,
      note: sections.size ? null : 'Искал только среди загруженных треков — пролистай «Загрузить ещё» на вкладке «Моя музыка», если не нашлось',
      error: found.length ? null : 'В моей музыке ничего не нашлось',
    });
  }

  function navigate(url) {
    if (W.nav && typeof W.nav.go === 'function') { W.nav.go(url); return true; }
    // SPA-переход без перезагрузки (полная перезагрузка остановила бы музыку).
    W.history.pushState({}, '', url);
    W.dispatchEvent(new W.PopStateEvent('popstate', { state: {} }));
    return true;
  }

  async function waitForRows(prevFirst, prevUrl) {
    const until = Date.now() + 10000;
    await sleep(800);
    // Переход на тот же раздел не меняет ни адрес, ни строки — тогда ждать смены строк незачем,
    // иначе пульт висел бы до таймаута.
    const samePage = location.href === prevUrl;
    let lastCount = -1;
    while (Date.now() < until) {
      const els = findRowElements();
      const changed = samePage || !prevFirst || els[0] !== prevFirst || !prevFirst.isConnected;
      if (els.length && changed && els.length === lastCount) return true;
      lastCount = els.length;
      await sleep(400);
    }
    return false;
  }

  async function openAndList(url, id, title) {
    const prevFirst = findRowElements()[0];
    const prevUrl = location.href;
    navigate(url);
    await waitForRows(prevFirst, prevUrl);
    await sendList(id, title);
  }

  async function loadMore(id, title) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1500);
    await sendList(id, title);
  }

  function playIndex(index, expect) {
    let el = rows[index];
    if (!el || !el.isConnected) {
      scrape();
      el = rows[index];
    }
    if (expect && el) {
      const got = parseRow(el);
      if (got.title !== expect.title) {
        const i = rows.findIndex((r) => parseRow(r).title === expect.title && parseRow(r).artist === expect.artist);
        if (i >= 0) el = rows[i];
      }
    }
    if (!el) return reportError('Трек не найден на странице — обнови список');
    // Строка трека в новом VK — переключатель: клик по уже звучащему треку ставит его на паузу.
    // Поэтому сначала смотрим, не он ли сейчас играет.
    const want = parseRow(el);
    const meta = W.navigator.mediaSession && W.navigator.mediaSession.metadata;
    if (meta && want.title && meta.title === want.title && (!want.artist || !meta.artist || meta.artist === want.artist)) {
      return player.isPlaying() ? undefined : player.play();
    }
    // Кнопку MusicTrackRow_PlaybackControls новый VK игнорирует, слушает только саму строку
    // (data-testid="audiorow-tappable", подпись «Начать прослушивание»).
    const btn =
      el.querySelector('[data-testid="audiorow-tappable"]') ||
      el.querySelector('.audio_row__play_btn, button[aria-label*="Воспроизв" i], button[aria-label*="play" i]') ||
      el.querySelector('[class*="play" i]');
    (btn || el).click();
  }

  function diagnostics() {
    const counts = {};
    for (const sel of ROW_SELECTORS) counts[sel] = document.querySelectorAll(sel).length;
    const hints = new Set();
    document.querySelectorAll('[class*="udio" i], [class*="rack" i], [data-testid]').forEach((el) => {
      if (hints.size > 80) return;
      const tid = el.getAttribute('data-testid');
      if (tid) hints.add('testid=' + tid);
      else hints.add('class=' + String(el.className).slice(0, 80));
    });
    const p = ap();
    return {
      url: location.href,
      hasAp: !!p,
      apMethods: p ? Object.getOwnPropertyNames(Object.getPrototypeOf(p) || {}).concat(Object.keys(p)).filter((k) => k !== 'constructor').slice(0, 60) : [],
      hasNavGo: !!(W.nav && W.nav.go),
      capturedAudio: !!media,
      mediaSession: W.navigator.mediaSession && W.navigator.mediaSession.metadata
        ? { title: W.navigator.mediaSession.metadata.title, artist: W.navigator.mediaSession.metadata.artist }
        : null,
      rowSelectorCounts: counts,
      firstRowText: (findRowElements()[0] || {}).innerText || null,
      domHints: [...hints],
    };
  }

  // ----- команды -----
  async function run(cmd) {
    try {
      switch (cmd.type) {
        case 'toggle': return player.toggle();
        case 'play': return player.play();
        case 'pause': return player.pause();
        case 'next': return player.next();
        case 'prev': return player.prev();
        case 'volume': return player.setVolume(cmd.value);
        case 'seek': return player.seek(cmd.value);
        case 'myMusic': return openAndList(MY_MUSIC_PATH, 'my', 'Моя музыка');
        case 'search':
          if (cmd.scope === 'my') return searchMine(cmd.q || '');
          return openAndList(SEARCH_PATH(cmd.q || ''), 'search', 'Поиск: ' + (cmd.q || ''));
        case 'scrapePage': return sendList('page', 'Со страницы ПК');
        case 'loadMore': return loadMore(cmd.listId || 'page', cmd.listTitle || 'Список');
        case 'playIndex': return playIndex(cmd.index, cmd.expect);
        case 'diagnose': return post('/agent/diag', diagnostics());
        default: return reportError('Неизвестная команда: ' + cmd.type);
      }
    } catch (e) {
      reportError(cmd.type + ': ' + e.message);
    }
  }


  async function pollLoop() {
    for (;;) {
      try {
        const r = await request('GET', '/agent/poll', null, 30000);
        for (const cmd of r.commands || []) {
          await run(cmd);
          setTimeout(pushState, 400);
        }
      } catch {
        await sleep(3000); // сервер не запущен — тихо ждём
      }
    }
  }

  function pushState() {
    return post('/agent/state', nowPlaying());
  }

  function start() {
    pollLoop();
    setInterval(pushState, 2000);
    console.log('[vk-remote] агент запущен');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
