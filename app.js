/* ---------- storage & state ---------- */
const STORAGE_KEY = 'lgv_progress_v2';
const INTERVALS = [0, 1, 2, 4, 7, 14, 30, 60, 120]; // days, indexed by box
const TOTAL_DAYS = 7;
const SESSION_SIZE = 25;

const byDay = {};
for (const e of VOCAB_DATA) {
  (byDay[e.day] ||= []).push(e);
}
const byNum = {};
for (const e of VOCAB_DATA) byNum[e.num] = e;

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function defaultProgress() {
  return {
    words: {},          // num -> {box, due, reps, lapses, seen}
    currentDay: 1,
    lastAdvanceDate: null,
    streak: 0,
    lastStudyDate: null,
    settings: { defaultFlipped: false },
    updatedAt: 0,        // ms epoch, bumped on every save; used for cross-device merge
  };
}

let PROGRESS = loadProgress();

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProgress();
    const p = JSON.parse(raw);
    const merged = Object.assign(defaultProgress(), p);
    merged.settings = Object.assign(defaultProgress().settings, p.settings || {});
    return merged;
  } catch (e) {
    return defaultProgress();
  }
}
function saveProgress(skipSync) {
  PROGRESS.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(PROGRESS));
  if (!skipSync) scheduleSyncPush();
}

function getState(num) {
  return PROGRESS.words[num] || { box: 0, due: null, reps: 0, lapses: 0, seen: false };
}
function setState(num, st) {
  PROGRESS.words[num] = st;
}

/* ---------- cross-device sync (GitHub Gist as backend) ---------- */
const SYNC_KEY = 'lgv_sync_v1';
const GIST_FILENAME = 'lgv-progress.json';
const GIST_DESC = 'LilyGRE Vocab Sync — do not delete';

function getSyncConfig() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); } catch (e) { return null; }
}
function setSyncConfig(cfg) {
  if (cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(SYNC_KEY);
}
function ghHeaders(token) {
  return { Authorization: 'token ' + token, Accept: 'application/vnd.github+json' };
}
// Sync data must always be fresh — never let the browser's HTTP cache serve a stale pull.
function ghFetch(url, opts) {
  return fetch(url, Object.assign({ cache: 'no-store' }, opts));
}

async function findOrCreateGist(token) {
  const listResp = await ghFetch('https://api.github.com/gists?per_page=100', { headers: ghHeaders(token) });
  if (!listResp.ok) throw new Error('無法讀取 Gist 列表 (' + listResp.status + ')');
  const gists = await listResp.json();
  const found = gists.find(g => g.description === GIST_DESC && g.files && g.files[GIST_FILENAME]);
  if (found) return found.id;
  const createResp = await ghFetch('https://api.github.com/gists', {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({
      description: GIST_DESC,
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify(PROGRESS) } },
    }),
  });
  if (!createResp.ok) throw new Error('無法建立 Gist (' + createResp.status + ')');
  const created = await createResp.json();
  return created.id;
}

async function pullFromGist(token, gistId) {
  const resp = await ghFetch('https://api.github.com/gists/' + gistId, { headers: ghHeaders(token) });
  if (!resp.ok) throw new Error('無法讀取進度 (' + resp.status + ')');
  const gist = await resp.json();
  const file = gist.files[GIST_FILENAME];
  if (!file || !file.content) return null;
  return JSON.parse(file.content);
}

async function pushToGist(token, gistId, data) {
  const resp = await ghFetch('https://api.github.com/gists/' + gistId, {
    method: 'PATCH',
    headers: ghHeaders(token),
    body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(data) } } }),
  });
  if (!resp.ok) throw new Error('同步失敗 (' + resp.status + ')');
}

function mergeProgress(local, remote) {
  if (!remote) return local;
  if (!local.updatedAt || remote.updatedAt > local.updatedAt) return Object.assign(defaultProgress(), remote);
  return local;
}

async function connectSync(token) {
  const userResp = await ghFetch('https://api.github.com/user', { headers: ghHeaders(token) });
  if (!userResp.ok) throw new Error('Token 無效或權限不足');
  const user = await userResp.json();
  const gistId = await findOrCreateGist(token);
  const remote = await pullFromGist(token, gistId);
  PROGRESS = mergeProgress(PROGRESS, remote);
  saveProgress(true);
  setSyncConfig({ token, gistId, username: user.login });
  await pushToGist(token, gistId, PROGRESS);
  return user.login;
}

function disconnectSync() {
  setSyncConfig(null);
}

let syncPushTimer = null;
function scheduleSyncPush() {
  const cfg = getSyncConfig();
  if (!cfg) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    pushToGist(cfg.token, cfg.gistId, PROGRESS).catch(() => {});
  }, 1500);
}

async function pullSyncOnLoad() {
  const cfg = getSyncConfig();
  if (!cfg) return;
  try {
    const remote = await pullFromGist(cfg.token, cfg.gistId);
    PROGRESS = mergeProgress(PROGRESS, remote);
    saveProgress(true);
  } catch (e) { /* offline or token revoked — keep working locally */ }
}

function ensureDayAdvance() {
  const today = todayStr();
  if (!PROGRESS.lastAdvanceDate) {
    PROGRESS.lastAdvanceDate = today;
    saveProgress();
    return;
  }
  if (PROGRESS.lastAdvanceDate !== today) {
    const diff = Math.max(1, daysBetween(PROGRESS.lastAdvanceDate, today));
    PROGRESS.currentDay = ((PROGRESS.currentDay - 1 + diff) % TOTAL_DAYS) + 1;
    PROGRESS.lastAdvanceDate = today;
    saveProgress();
  }
}

function touchStreak() {
  const today = todayStr();
  if (PROGRESS.lastStudyDate === today) return;
  if (PROGRESS.lastStudyDate && daysBetween(PROGRESS.lastStudyDate, today) === 1) {
    PROGRESS.streak += 1;
  } else {
    PROGRESS.streak = 1;
  }
  PROGRESS.lastStudyDate = today;
  saveProgress();
}

/* ---------- queues ---------- */
function isSeen(num) { return !!getState(num).seen; }
function isDue(num) {
  const st = getState(num);
  if (!st.seen) return false;
  return st.due <= todayStr();
}

function dueList(pool) {
  return pool.filter(e => isDue(e.num));
}
function newList(pool) {
  return pool.filter(e => !isSeen(e.num));
}

function dayStats(dayNum) {
  const pool = byDay[dayNum] || [];
  const seenCount = pool.filter(e => isSeen(e.num)).length;
  return { total: pool.length, seen: seenCount, pct: pool.length ? Math.round(seenCount / pool.length * 100) : 0 };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildCommuteQueue() {
  const currentPool = byDay[PROGRESS.currentDay] || [];
  const due = dueList(VOCAB_DATA);
  const fresh = newList(currentPool);
  let queue = shuffle(due).slice(0, 20).concat(fresh.slice(0, SESSION_SIZE));
  if (queue.length === 0) {
    // everything caught up -- offer ahead-of-schedule words from the next unfinished day
    for (let i = 0; i < TOTAL_DAYS; i++) {
      const d = ((PROGRESS.currentDay - 1 + i) % TOTAL_DAYS) + 1;
      const f = newList(byDay[d] || []);
      if (f.length) { queue = f.slice(0, SESSION_SIZE); break; }
    }
  }
  return shuffle(queue).slice(0, SESSION_SIZE);
}

/* ---------- rating / SRS ---------- */
function rateWord(num, rating) {
  const st = getState(num);
  st.seen = true;
  st.reps = (st.reps || 0) + 1;
  if (rating === 'again') {
    st.box = 0;
    st.lapses = (st.lapses || 0) + 1;
  } else if (rating === 'hard') {
    st.box = Math.max(1, st.box);
  } else if (rating === 'good') {
    st.box = Math.min(INTERVALS.length - 1, st.box + 1);
  } else if (rating === 'easy') {
    st.box = Math.min(INTERVALS.length - 1, st.box + 2);
  }
  st.due = addDays(todayStr(), INTERVALS[st.box]);
  setState(num, st);
  saveProgress();
  touchStreak();
}

/* ---------- view management ---------- */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ---------- HOME ---------- */
function renderHome() {
  ensureDayAdvance();
  document.getElementById('home-day-num').textContent = PROGRESS.currentDay;
  const pool = byDay[PROGRESS.currentDay] || [];
  if (pool.length) {
    document.getElementById('home-day-range').textContent =
      `${pool[0].word} ⋯ ${pool[pool.length - 1].word}（${pool.length} 字）`;
  }
  const st = dayStats(PROGRESS.currentDay);
  const pct = st.pct;
  const circumference = 326.7256;
  document.getElementById('ring-fg').style.strokeDashoffset = String(circumference * (1 - pct / 100));
  document.getElementById('ring-pct').textContent = pct + '%';

  document.getElementById('stat-due').textContent = st.seen;
  document.getElementById('stat-new').textContent = newList(pool).length;
  document.getElementById('stat-streak').textContent = PROGRESS.streak;

  const dotsEl = document.getElementById('day-dots');
  dotsEl.innerHTML = '';
  for (let d = 1; d <= TOTAL_DAYS; d++) {
    const s = dayStats(d);
    const div = document.createElement('div');
    div.className = 'day-dot' + (d === PROGRESS.currentDay ? ' current' : '') + (s.pct === 100 ? ' done' : '');
    div.textContent = 'D' + d;
    div.onclick = () => { PROGRESS.currentDay = d; saveProgress(); renderHome(); };
    dotsEl.appendChild(div);
  }
}

/* ---------- FLASHCARD SESSION (簡潔線性瀏覽) ---------- */
let session = { queue: [], idx: 0, flipped: false };

function startSession() {
  // 當天的字,依順序;把還沒學過的排前面,學過的排後面(方便一週一輪)
  const pool = (byDay[PROGRESS.currentDay] || []).slice();
  const unseen = pool.filter(e => !isSeen(e.num));
  const seen = pool.filter(e => isSeen(e.num));
  session = { queue: unseen.concat(seen), idx: 0, flipped: false };
  if (session.queue.length === 0) {
    alert('這一天沒有單字，換一天試試。');
    return;
  }
  touchStreak();
  showView('view-session');
  renderCard();
}

function currentEntry() { return session.queue[session.idx]; }

function renderCard() {
  const e = currentEntry();
  if (!e) { finishSession(); return; }
  const card = document.getElementById('flashcard');
  session.flipped = !!PROGRESS.settings.defaultFlipped;
  card.classList.toggle('flipped', session.flipped);

  document.getElementById('card-root').textContent = e.root ? '🌱 ' + e.root : '';
  document.getElementById('card-word').textContent = e.word;
  document.getElementById('card-word-back').textContent = e.word;
  document.getElementById('card-root-back').textContent =
    e.root ? '🌱 ' + e.root + (e.root_gloss ? ' — ' + e.root_gloss : '') : '';
  document.getElementById('card-mnemonic').textContent = e.mnemonic || (e.meaning_zh || []).join('；');
  document.getElementById('card-zh').textContent = (e.meaning_zh || []).join('；');
  document.getElementById('card-example').innerHTML = (e.example || []).map(x => escapeHtml(x)).join('<br><br>');
  document.getElementById('card-example-wrap').style.display = (e.example || []).length ? '' : 'none';

  exposeWord(e.num); // 看過即標記,更新進度
  const pct = Math.round((session.idx + 1) / session.queue.length * 100);
  document.getElementById('session-progress-fill').style.width = pct + '%';
  document.getElementById('session-progress-count').textContent = `${session.idx + 1} / ${session.queue.length}`;
  document.getElementById('session-progress-pct').textContent = pct + '%';
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function flipCard() {
  const card = document.getElementById('flashcard');
  session.flipped = !session.flipped;
  card.classList.toggle('flipped', session.flipped);
}

function nextCard() {
  if (session.idx >= session.queue.length - 1) { finishSession(); return; }
  session.idx++;
  renderCard();
}
function prevCard() {
  if (session.idx <= 0) return;
  session.idx--;
  renderCard();
}

function finishSession() {
  const st = dayStats(PROGRESS.currentDay);
  document.getElementById('done-stats').innerHTML =
    `Day ${PROGRESS.currentDay} 這一輪看完了！<br><br>本日已學過 <b>${st.seen}/${st.total}</b> 字`;
  document.getElementById('btn-done-next').style.display = 'none';
  showView('view-done');
}

/* ---------- QUIZ MODE ---------- */
let quiz = { queue: [], idx: 0, score: 0 };

function startQuiz() {
  const pool = byDay[PROGRESS.currentDay] || VOCAB_DATA;
  quiz = { queue: shuffle(pool).slice(0, 15), idx: 0, score: 0 };
  if (quiz.queue.length < 4) {
    alert('這天的單字量不足以出選擇題，換一天試試。');
    return;
  }
  showView('view-quiz');
  document.getElementById('quiz-score').textContent = '0';
  renderQuiz();
}

function renderQuiz() {
  const e = quiz.queue[quiz.idx];
  if (!e) { finishQuiz(); return; }
  document.getElementById('quiz-word').textContent = e.word;
  document.getElementById('quiz-root').textContent = e.root ? '🌱 ' + e.root : '';

  const correct = (e.meaning_zh && e.meaning_zh[0]) || '（無資料）';
  let sameRoot = VOCAB_DATA.filter(x => x.root === e.root && x.num !== e.num && x.meaning_zh && x.meaning_zh[0]);
  let distractors = shuffle(sameRoot).slice(0, 2).map(x => x.meaning_zh[0]);
  while (distractors.length < 3) {
    const r = VOCAB_DATA[Math.floor(Math.random() * VOCAB_DATA.length)];
    const m = r.meaning_zh && r.meaning_zh[0];
    if (m && m !== correct && !distractors.includes(m)) distractors.push(m);
  }
  const options = shuffle([correct, ...distractors]);

  const wrap = document.getElementById('quiz-options');
  wrap.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'quiz-opt';
    btn.textContent = opt;
    btn.onclick = () => answerQuiz(btn, opt, correct, e);
    wrap.appendChild(btn);
  });

  document.getElementById('quiz-progress-fill').style.width = (quiz.idx / quiz.queue.length * 100) + '%';
}

function answerQuiz(btn, opt, correct, entry) {
  document.querySelectorAll('.quiz-opt').forEach(b => {
    b.onclick = null;
    if (b.textContent === correct) b.classList.add('correct');
  });
  const isRight = opt === correct;
  if (!isRight) btn.classList.add('wrong');
  else quiz.score++;
  document.getElementById('quiz-score').textContent = quiz.score;
  rateWord(entry.num, isRight ? 'good' : 'again');
  setTimeout(() => { quiz.idx++; renderQuiz(); }, 900);
}

function finishQuiz() {
  document.getElementById('done-stats').innerHTML = `選擇題結果：${quiz.score} / ${quiz.queue.length} 答對`;
  showView('view-done');
}

/* ---------- LISTEN MODE ---------- */
let listen = { queue: [], idx: 0, playing: false };

function startListen() {
  const pool = byDay[PROGRESS.currentDay] || [];
  listen.queue = shuffle(dueList(VOCAB_DATA).concat(newList(pool))).slice(0, 40);
  if (listen.queue.length === 0) listen.queue = shuffle(pool).slice(0, 40);
  listen.idx = 0;
  listen.playing = true;
  document.getElementById('btn-listen-toggle').textContent = '⏸';
  showView('view-listen');
  touchStreak();
  speakCurrent();
}

function speakCurrent() {
  if (!listen.playing) return;
  const e = listen.queue[listen.idx];
  if (!e) { showView('view-home'); renderHome(); return; }
  document.getElementById('listen-word').textContent = e.word;
  document.getElementById('listen-zh').textContent = (e.meaning_zh || []).join('；');
  document.getElementById('listen-mnemonic').textContent = e.mnemonic || '';
  document.getElementById('listen-progress').textContent = `${listen.idx + 1} / ${listen.queue.length}`;

  if (!('speechSynthesis' in window)) {
    setTimeout(() => { listen.idx++; speakCurrent(); }, 2500);
    return;
  }
  window.speechSynthesis.cancel();
  const u1 = new SpeechSynthesisUtterance(e.word);
  u1.lang = 'en-US';
  u1.rate = 0.85;
  const zh = (e.meaning_zh || []).join('，');
  u1.onend = () => {
    if (!listen.playing) return;
    if (!zh) { advanceListen(); return; }
    const u2 = new SpeechSynthesisUtterance(zh);
    u2.lang = 'zh-TW';
    u2.rate = 1;
    u2.onend = advanceListen;
    window.speechSynthesis.speak(u2);
  };
  window.speechSynthesis.speak(u1);
  exposeWord(e.num);
}

function exposeWord(num) {
  const st = getState(num);
  if (!st.seen) {
    st.seen = true;
    st.box = 0;
    st.due = todayStr();
    setState(num, st);
    saveProgress();
  }
}

function advanceListen() {
  if (!listen.playing) return;
  setTimeout(() => {
    if (!listen.playing) return;
    listen.idx++;
    speakCurrent();
  }, 500);
}

function toggleListen() {
  listen.playing = !listen.playing;
  document.getElementById('btn-listen-toggle').textContent = listen.playing ? '⏸' : '▶';
  if (listen.playing) speakCurrent();
  else window.speechSynthesis.cancel();
}

/* ---------- STATS VIEW ---------- */
function renderStats() {
  const totalSeen = VOCAB_DATA.filter(e => isSeen(e.num)).length;
  const daysDone = [1,2,3,4,5,6,7].filter(d => dayStats(d).pct === 100).length;
  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-chip"><span>${totalSeen}</span><label>已學過 / ${VOCAB_DATA.length}</label></div>
    <div class="stat-chip"><span>${Math.round(totalSeen / VOCAB_DATA.length * 100)}%</span><label>總進度</label></div>
    <div class="stat-chip"><span>${daysDone}/7</span><label>完成天數</label></div>
    <div class="stat-chip"><span>${PROGRESS.streak}</span><label>🔥 連續天數</label></div>
  `;
  const daysEl = document.getElementById('stats-days');
  daysEl.innerHTML = '';
  for (let d = 1; d <= TOTAL_DAYS; d++) {
    const s = dayStats(d);
    const row = document.createElement('div');
    row.className = 'day-row';
    row.innerHTML = `<div class="dlabel">Day ${d}</div><div class="dbar"><div class="dbar-fill" style="width:${s.pct}%"></div></div><div class="dnum">${s.seen}/${s.total}</div>`;
    daysEl.appendChild(row);
  }

  document.getElementById('toggle-default-flip').setAttribute('aria-checked', String(!!PROGRESS.settings.defaultFlipped));
  renderSyncUI();
}

function renderSyncUI() {
  const cfg = getSyncConfig();
  const statusEl = document.getElementById('sync-status');
  statusEl.classList.remove('ok', 'err');
  if (cfg) {
    statusEl.textContent = `已連接 GitHub 帳號「${cfg.username}」，會自動同步進度。`;
    statusEl.classList.add('ok');
    document.getElementById('sync-connect-box').style.display = 'none';
    document.getElementById('sync-connected-box').style.display = '';
  } else {
    statusEl.textContent = '尚未連接。連接後手機和電腦會自動同步同一份進度。';
    document.getElementById('sync-connect-box').style.display = '';
    document.getElementById('sync-connected-box').style.display = 'none';
  }
}

/* ---------- import / export / reset ---------- */
function exportProgress() {
  const blob = new Blob([JSON.stringify(PROGRESS, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lilygre-progress-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function importProgress(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const p = JSON.parse(reader.result);
      PROGRESS = Object.assign(defaultProgress(), p);
      saveProgress();
      renderStats();
      renderHome();
      alert('匯入成功！');
    } catch (e) {
      alert('檔案格式錯誤，匯入失敗。');
    }
  };
  reader.readAsText(file);
}

/* ---------- wiring ---------- */
document.getElementById('btn-start-session').onclick = startSession;
document.getElementById('btn-quiz-mode').onclick = startQuiz;
document.getElementById('btn-listen-mode').onclick = startListen;
document.getElementById('btn-stats').onclick = () => { renderStats(); showView('view-stats'); };
document.getElementById('btn-exit-stats').onclick = () => { showView('view-home'); renderHome(); };

document.getElementById('btn-exit-session').onclick = () => {
  window.speechSynthesis && window.speechSynthesis.cancel();
  showView('view-home'); renderHome();
};
document.getElementById('flashcard').onclick = flipCard;
document.getElementById('btn-next').onclick = nextCard;
document.getElementById('btn-prev').onclick = prevCard;
document.getElementById('btn-speak').onclick = (ev) => {
  ev.stopPropagation();
  const e = currentEntry();
  if (!e || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(e.word);
  u.lang = 'en-US'; u.rate = 0.85;
  window.speechSynthesis.speak(u);
};

document.getElementById('btn-exit-quiz').onclick = () => { showView('view-home'); renderHome(); };
document.getElementById('btn-exit-listen').onclick = () => {
  listen.playing = false;
  window.speechSynthesis && window.speechSynthesis.cancel();
  showView('view-home'); renderHome();
};
document.getElementById('btn-listen-toggle').onclick = toggleListen;
document.getElementById('btn-done-home').onclick = () => { showView('view-home'); renderHome(); };

document.getElementById('btn-export').onclick = exportProgress;
document.getElementById('btn-import').onclick = () => document.getElementById('import-file').click();
document.getElementById('import-file').onchange = (ev) => {
  if (ev.target.files[0]) importProgress(ev.target.files[0]);
};
document.getElementById('btn-reset').onclick = () => {
  if (confirm('確定要重置所有學習進度嗎？此動作無法復原。')) {
    PROGRESS = defaultProgress();
    saveProgress();
    renderStats();
    renderHome();
  }
};

document.getElementById('toggle-default-flip').onclick = (ev) => {
  PROGRESS.settings.defaultFlipped = !PROGRESS.settings.defaultFlipped;
  ev.currentTarget.setAttribute('aria-checked', String(PROGRESS.settings.defaultFlipped));
  saveProgress();
};

document.getElementById('btn-sync-connect').onclick = async () => {
  const btn = document.getElementById('btn-sync-connect');
  const input = document.getElementById('sync-token-input');
  const token = input.value.trim();
  if (!token) { alert('請先貼上 Token。'); return; }
  btn.disabled = true;
  btn.textContent = '連接中…';
  const statusEl = document.getElementById('sync-status');
  try {
    const username = await connectSync(token);
    input.value = '';
    renderSyncUI();
    renderStats();
    renderHome();
    statusEl.textContent = `已連接 GitHub 帳號「${username}」，進度已同步。`;
    statusEl.classList.remove('err'); statusEl.classList.add('ok');
  } catch (e) {
    statusEl.textContent = '連接失敗：' + e.message;
    statusEl.classList.remove('ok'); statusEl.classList.add('err');
  } finally {
    btn.disabled = false;
    btn.textContent = '連接';
  }
};

document.getElementById('btn-sync-now').onclick = async () => {
  const btn = document.getElementById('btn-sync-now');
  const cfg = getSyncConfig();
  if (!cfg) return;
  btn.disabled = true;
  btn.textContent = '同步中…';
  const statusEl = document.getElementById('sync-status');
  try {
    const remote = await pullFromGist(cfg.token, cfg.gistId);
    PROGRESS = mergeProgress(PROGRESS, remote);
    saveProgress(true);
    await pushToGist(cfg.token, cfg.gistId, PROGRESS);
    renderStats();
    renderHome();
    statusEl.textContent = `已同步（${new Date().toLocaleTimeString('zh-TW')}）`;
    statusEl.classList.remove('err'); statusEl.classList.add('ok');
  } catch (e) {
    statusEl.textContent = '同步失敗：' + e.message;
    statusEl.classList.remove('ok'); statusEl.classList.add('err');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 立即同步';
  }
};

document.getElementById('btn-sync-disconnect').onclick = () => {
  if (confirm('確定要中斷同步嗎？本機的進度會保留，但不會再自動更新到雲端。')) {
    disconnectSync();
    renderSyncUI();
  }
};

/* 鍵盤:空白鍵翻面,左右方向鍵換卡(桌機測試用) */
document.addEventListener('keydown', (ev) => {
  if (!document.getElementById('view-session').classList.contains('active')) return;
  if (ev.code === 'Space') { ev.preventDefault(); flipCard(); }
  if (ev.key === 'ArrowRight') nextCard();
  if (ev.key === 'ArrowLeft') prevCard();
});

/* 滑動:向左看下一個,向右看上一個 */
(function () {
  let startX = null, startY = null;
  const stage = document.querySelector('.card-stage');
  stage.addEventListener('touchstart', (ev) => {
    const t = ev.touches[0]; startX = t.clientX; startY = t.clientY;
  }, { passive: true });
  stage.addEventListener('touchend', (ev) => {
    if (startX === null) { startX = null; return; }
    const t = ev.changedTouches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 60) {
      if (dx < 0) nextCard(); else prevCard();
    }
    startX = null;
  });
})();

/* ---------- init ---------- */
renderHome();
pullSyncOnLoad().then(() => {
  // only refresh the visible screen; don't yank the user out of an active session
  if (document.querySelector('.view.active').id === 'view-home') renderHome();
});
