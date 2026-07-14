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
// 純本機記錄(如每日換天),不更新 updatedAt——避免「才剛打開網頁」就讓
// 本機舊資料看起來比雲端新。
function saveLocalOnly() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(PROGRESS));
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
  // 以較新的一份為基底(currentDay、設定等),但單字進度採「逐字聯集」,
  // 任何一台裝置都不可能把另一台已背過的字洗掉。
  const base = (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
  const out = Object.assign(defaultProgress(), base);
  out.settings = Object.assign(defaultProgress().settings, base.settings || {});
  out.words = {};
  const nums = new Set([...Object.keys(local.words || {}), ...Object.keys(remote.words || {})]);
  for (const n of nums) {
    const a = (local.words || {})[n];
    const b = (remote.words || {})[n];
    if (!a) { out.words[n] = b; continue; }
    if (!b) { out.words[n] = a; continue; }
    // 兩邊都有:取複習次數多的;平手取 box 高的(較熟)
    const chosen = (b.reps || 0) > (a.reps || 0) ||
      ((b.reps || 0) === (a.reps || 0) && (b.box || 0) > (a.box || 0)) ? b : a;
    // 難字標記與封存狀態兩邊取聯集,任何一邊操作過都保留
    chosen.star = !!(a.star || b.star);
    chosen.archived = !!(a.archived || b.archived);
    out.words[n] = chosen;
  }
  out.streak = Math.max(local.streak || 0, remote.streak || 0);
  return out;
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
// 開站時本機可能還是舊資料:在完成第一次雲端拉取前,禁止任何自動上傳,
// 避免筆電用舊進度把手機的新進度蓋掉。
let syncPullDone = !getSyncConfig();

function scheduleSyncPush() {
  const cfg = getSyncConfig();
  if (!cfg || !syncPullDone) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    pushToGist(cfg.token, cfg.gistId, PROGRESS).catch(() => {});
  }, 1500);
}

async function pullSyncOnLoad() {
  const cfg = getSyncConfig();
  if (!cfg) { syncPullDone = true; return; }
  try {
    const remote = await pullFromGist(cfg.token, cfg.gistId);
    PROGRESS = mergeProgress(PROGRESS, remote);
    saveProgress(true);
  } catch (e) { /* offline or token revoked — keep working locally */ }
  finally { syncPullDone = true; }
}

function ensureDayAdvance() {
  const today = todayStr();
  if (!PROGRESS.lastAdvanceDate) {
    PROGRESS.lastAdvanceDate = today;
    saveLocalOnly();
    return;
  }
  if (PROGRESS.lastAdvanceDate !== today) {
    const diff = Math.max(1, daysBetween(PROGRESS.lastAdvanceDate, today));
    PROGRESS.currentDay = ((PROGRESS.currentDay - 1 + diff) % TOTAL_DAYS) + 1;
    PROGRESS.lastAdvanceDate = today;
    saveLocalOnly();
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
  // 已封存的字視為「不存在」:不列入總數也不列入待學
  const pool = (byDay[dayNum] || []).filter(e => !isArchived(e.num));
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

/* ---------- FLASHCARD SESSION (Reels 式上下滑瀏覽) ---------- */
let session = { queue: [], idx: 0, flipped: false };

function isArchived(num) { return !!getState(num).archived; }
function activeDayPool(dayNum) {
  return (byDay[dayNum] || []).filter(e => !isArchived(e.num));
}

function startSession() {
  // 當天還沒封存的字,依順序;沒學過的排前面,學過的排後面(方便一週一輪)
  const pool = activeDayPool(PROGRESS.currentDay);
  const unseen = pool.filter(e => !isSeen(e.num));
  const seen = pool.filter(e => isSeen(e.num));
  session = { queue: unseen.concat(seen), idx: 0, flipped: false };
  if (session.queue.length === 0) {
    alert('這一天的字都封存完了,太強了!換一天,或到統計頁復原已封存的字。');
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
  const hookEl = document.getElementById('card-mnemonic');
  hookEl.textContent = e.mnemonic || '';
  hookEl.style.display = e.mnemonic ? '' : 'none';
  document.getElementById('card-zh').textContent = (e.meaning_zh || []).join('；');
  document.getElementById('card-example').innerHTML = (e.example || []).map(x => escapeHtml(x)).join('<br><br>');
  document.getElementById('card-example-wrap').style.display = (e.example || []).length ? '' : 'none';
  document.getElementById('card-syn').textContent = (e.synonyms || []).join(', ').replace(/,\s*$/, '');
  document.getElementById('card-syn-wrap').style.display = (e.synonyms || []).length ? '' : 'none';

  exposeWord(e.num); // 看過即標記,更新進度
  // 進度條顯示「當天累積進度」(排除已封存),退出再進來會接續
  const st = dayStats(PROGRESS.currentDay);
  const pct = st.total ? Math.round(st.seen / st.total * 100) : 0;
  document.getElementById('session-progress-fill').style.width = pct + '%';
  document.getElementById('session-progress-count').textContent = `${st.seen} / ${st.total}`;
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

/* Reels 式過場:整張卡飛出畫面 → 換內容 → 從反方向滑入。
   全用計時器與行內樣式,避免背景分頁 rAF 凍結造成卡片卡在透明狀態。 */
let swapping = false;
function flySwap(dir, apply) {
  if (swapping) return;
  swapping = true;
  const sw = document.getElementById('card-swiper');
  const h = document.querySelector('.card-stage').clientHeight || 600;
  const out = dir === 'up' ? -h : h;
  sw.style.transition = 'transform .17s cubic-bezier(.3,.7,.5,1),opacity .17s ease';
  sw.style.transform = `translateY(${out}px)`;
  sw.style.opacity = '0.15';
  setTimeout(() => {
    apply();
    sw.style.transition = 'none';
    sw.style.transform = `translateY(${-out * 0.9}px)`;
    void sw.offsetHeight;
    sw.style.transition = 'transform .24s cubic-bezier(.17,.84,.35,1),opacity .24s ease';
    sw.style.transform = '';
    sw.style.opacity = '';
    setTimeout(() => { sw.style.transition = ''; swapping = false; }, 260);
  }, 170);
  // 保險絲:無論如何 800ms 後恢復可見與可操作
  setTimeout(() => {
    sw.style.transition = ''; sw.style.transform = ''; sw.style.opacity = '';
    swapping = false;
  }, 800);
}

function nextCard() {
  if (session.idx >= session.queue.length - 1) { finishSession(); return; }
  flySwap('up', () => { session.idx++; renderCard(); });
}
function prevCard() {
  if (session.idx <= 0) return;
  flySwap('down', () => { session.idx--; renderCard(); });
}

function archiveCurrent() {
  const e = currentEntry();
  if (!e) return;
  const st = getState(e.num);
  st.archived = true;
  st.seen = true;
  setState(e.num, st);
  saveProgress();
  session.queue.splice(session.idx, 1);
  if (session.queue.length === 0) { finishSession(); return; }
  if (session.idx >= session.queue.length) session.idx = session.queue.length - 1;
  flySwap('up', () => renderCard());
}

function finishSession() {
  const st = dayStats(PROGRESS.currentDay);
  const archived = VOCAB_DATA.filter(e => isArchived(e.num)).length;
  document.getElementById('done-stats').innerHTML =
    `Day ${PROGRESS.currentDay} 這一輪看完了！<br><br>本日已學過 <b>${st.seen}/${st.total}</b> 字` +
    (archived ? `<br>已封存 <b>${archived}</b> 個已會的字` : '');
  document.getElementById('btn-done-next').style.display = 'none';
  showView('view-done');
}

/* ---------- QUIZ MODE ---------- */
let quiz = { queue: [], idx: 0, score: 0 };

function startQuiz() {
  const pool = activeDayPool(PROGRESS.currentDay);
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
  const pool = activeDayPool(PROGRESS.currentDay);
  listen.queue = shuffle(pool.filter(e => !isSeen(e.num))).slice(0, 40);
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
  renderArchivedList();
  renderSyncUI();
}

function renderArchivedList() {
  const wrap = document.getElementById('archived-list');
  const archived = VOCAB_DATA.filter(e => isArchived(e.num));
  wrap.innerHTML = '';
  if (archived.length === 0) {
    wrap.innerHTML = '<div class="archived-empty">還沒有封存任何字。</div>';
    return;
  }
  for (const e of archived) {
    const row = document.createElement('div');
    row.className = 'archived-row';
    row.innerHTML = `<span class="aw">${e.word}</span><span class="az">${(e.meaning_zh || []).join('；')}</span><span class="ar">復原</span>`;
    row.onclick = () => {
      const st = getState(e.num);
      st.archived = false;
      setState(e.num, st);
      saveProgress();
      renderStats();
      renderHome();
      showView('view-stats');
    };
    wrap.appendChild(row);
  }
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
document.getElementById('btn-archive').onclick = (ev) => {
  ev.stopPropagation();
  archiveCurrent();
};
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

/* 鍵盤:空白鍵翻面,上下(或左右)方向鍵換卡(桌機測試用) */
document.addEventListener('keydown', (ev) => {
  if (!document.getElementById('view-session').classList.contains('active')) return;
  if (ev.code === 'Space') { ev.preventDefault(); flipCard(); }
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') { ev.preventDefault(); nextCard(); }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') { ev.preventDefault(); prevCard(); }
});

/* IG Reels 式跟手滑動:卡片跟著手指移動,放手依距離/速度決定甩出或彈回。
   背面內容可捲動時優先讓它捲,捲到邊界才接手換卡手勢。 */
(function () {
  const stage = document.querySelector('.card-stage');
  const sw = document.getElementById('card-swiper');
  let sx = 0, sy = 0, lastY = 0, lastT = 0, vel = 0;
  let mode = null; // null=未定, 'swipe'=跟手換卡, 'scroll'=讓背面捲動, 'none'=橫向,忽略
  let dragging = false;

  function backCanScroll(dirUp) {
    if (!session.flipped) return false;
    const el = document.querySelector('.card-back');
    if (el.scrollHeight - el.clientHeight < 5) return false;
    if (dirUp) return (el.scrollHeight - el.scrollTop - el.clientHeight) > 5;
    return el.scrollTop > 5;
  }

  stage.addEventListener('touchstart', (ev) => {
    if (swapping) return;
    const t = ev.touches[0];
    sx = t.clientX; sy = t.clientY; lastY = t.clientY; lastT = Date.now();
    vel = 0; mode = null; dragging = true;
    sw.style.transition = 'none';
  }, { passive: true });

  stage.addEventListener('touchmove', (ev) => {
    if (!dragging || swapping) return;
    const t = ev.touches[0];
    const dy = t.clientY - sy, dx = t.clientX - sx;
    const now = Date.now();
    vel = (t.clientY - lastY) / Math.max(1, now - lastT);
    lastY = t.clientY; lastT = now;

    if (mode === null) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return; // 還看不出方向
      if (Math.abs(dx) > Math.abs(dy)) { mode = 'none'; return; }
      mode = backCanScroll(dy < 0) ? 'scroll' : 'swipe';
    }
    if (mode !== 'swipe') return;
    ev.preventDefault();
    // 邊界阻尼:第一張往下拉、最後一張往上推時有「拉不動」的手感
    let y = dy;
    if (session.idx === 0 && dy > 0) y = dy * 0.3;
    if (session.idx >= session.queue.length - 1 && dy < 0) y = dy * 0.55;
    sw.style.transform = `translateY(${y}px)`;
    sw.style.opacity = String(Math.max(0.4, 1 - Math.abs(y) / 600));
  }, { passive: false });

  stage.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    if (mode !== 'swipe') { mode = null; sw.style.transition = ''; return; }
    mode = null;
    const dy = lastY - sy;
    const commit = Math.abs(dy) > 90 || Math.abs(vel) > 0.55;
    if (commit && dy < 0) {
      if (session.idx < session.queue.length - 1) { finishDrag('up', () => { session.idx++; renderCard(); }); return; }
      springBack(); finishSession(); return;
    }
    if (commit && dy > 0 && session.idx > 0) { finishDrag('down', () => { session.idx--; renderCard(); }); return; }
    springBack();
  }, { passive: true });

  // 從目前手指位置直接甩出畫面,再從反向滑入 — 不會先跳回原點
  function finishDrag(dir, apply) {
    swapping = true;
    const h = stage.clientHeight || 600;
    const out = dir === 'up' ? -h : h;
    sw.style.transition = 'transform .15s cubic-bezier(.3,.7,.5,1),opacity .15s ease';
    sw.style.transform = `translateY(${out}px)`;
    sw.style.opacity = '0.1';
    setTimeout(() => {
      apply();
      sw.style.transition = 'none';
      sw.style.transform = `translateY(${-out * 0.9}px)`;
      void sw.offsetHeight;
      sw.style.transition = 'transform .24s cubic-bezier(.17,.84,.35,1),opacity .24s ease';
      sw.style.transform = ''; sw.style.opacity = '';
      setTimeout(() => { sw.style.transition = ''; swapping = false; }, 260);
    }, 150);
    setTimeout(() => { sw.style.transition = ''; sw.style.transform = ''; sw.style.opacity = ''; swapping = false; }, 800);
  }

  function springBack() {
    sw.style.transition = 'transform .3s cubic-bezier(.17,.84,.35,1.15),opacity .3s ease';
    sw.style.transform = ''; sw.style.opacity = '';
    setTimeout(() => { sw.style.transition = ''; }, 320);
  }
})();

/* ---------- init ---------- */
renderHome();
pullSyncOnLoad().then(() => {
  // only refresh the visible screen; don't yank the user out of an active session
  if (document.querySelector('.view.active').id === 'view-home') renderHome();
});
