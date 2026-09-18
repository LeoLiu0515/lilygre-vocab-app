/* ---------- storage & state ---------- */
const STORAGE_KEY = 'lgv_progress_v2';
// 一份的配額 = 目前還沒搞定的字 ÷ 7,即時算,標越多、每份越小。
// 沒有「第幾天」也沒有「今天」了 —— 這是一份一份的份量,不是跟著日曆走的每日目標,
// 背完一份馬上就能開始下一份,不用等隔天。
const QUOTA_DIVISOR = 7;

const byNum = {};
for (const e of VOCAB_DATA) byNum[e.num] = e;

// 「今天」用裝置本地時間、凌晨 4 點才換日(不是午夜)。
// 曾經試過寫死台灣時區(UTC+8),但使用者人在國外(裝置是當地時區)時,
// 台灣的凌晨 4 點跟他自己感覺的「今天」差了大半天,近七天那排圓圈會整個
// 錯位、星期幾對不上他實際背的那天 —— 這是修過的 bug,不要再寫死時區。
// 用「現在時間 - 4 小時」取本地日期,不管裝置在哪個時區都對得上使用者自己的一天。
function todayStr() {
  const DAY_START_OFFSET_MS = 4 * 3600000;
  const d = new Date(Date.now() - DAY_START_OFFSET_MS);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}
function addDaysStr(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function defaultProgress() {
  return {
    words: {},          // num -> {box, due, reps, lapses, seen}
    streak: 0,
    lastStudyDate: null,
    // showNew / showImpress / showKnown:三個分類要不要出現在單字卡。
    // 預設「已會」關著,跟舊版「封存的字永不出現」行為一致。
    settings: { defaultFlipped: false, shuffleOrder: false, showNew: true, showImpress: true, showKnown: false },
    dailySeen: [],       // 這一份已經背過的 num,只有手動「開始下一份」才會清空
    calDate: null,       // calSeen 是哪一個(日曆)天的,只給「近七天」統計用
    calSeen: [],         // 今天(日曆天,本地凌晨 4 點換日)背過的 num,跟上面的「份」無關
    dailyHistory: {},    // 'YYYY-MM-DD' -> {done, quota},給首頁「近七天」用
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
  // Object.assign so partial records (e.g. the minimal {archived,seen} entries kept
  // across a "reset study progress" wipe) always get sane SRS defaults filled in.
  return Object.assign({ box: 0, due: null, reps: 0, lapses: 0, seen: false }, PROGRESS.words[num] || {});
}
function setState(num, st) {
  PROGRESS.words[num] = st;
}

/* ---------- 三分類 ----------
   1 已會   = 舊的 archived 旗標(絕對不動,舊資料直接就是第一類)
   2 有印象 = 短期記得,但不確定會不會忘
   3 還沒背 = 其餘全部(預設)                                        */
const TIER_KNOWN = 1, TIER_IMPRESS = 2, TIER_NEW = 3;
const TIER_LABEL = { 1: '✓ 已會', 2: '🤔 有印象', 3: '還沒背' };

function tierOf(num) {
  const st = getState(num);
  if (st.archived) return TIER_KNOWN;
  if (st.impress) return TIER_IMPRESS;
  return TIER_NEW;
}
function setTier(num, tier) {
  const st = getState(num);
  st.archived = tier === TIER_KNOWN;
  st.impress = tier === TIER_IMPRESS;
  if (tier !== TIER_NEW) st.seen = true;
  setState(num, st);
  saveProgress();
}
function tierVisible(tier) {
  const s = PROGRESS.settings;
  if (tier === TIER_KNOWN) return !!s.showKnown;
  if (tier === TIER_IMPRESS) return !!s.showImpress;
  return !!s.showNew;
}
function isVisible(num) { return tierVisible(tierOf(num)); }

/* ---------- 一份的配額 ----------
   quotaPool = 目前還沒搞定的字:有印象 + 還沒背,只算分類 toggle 有開的
   那些,已會永遠不算進去(即使打開 toggle 複習也一樣)。這是即時數字,
   關掉「有印象」就只剩「還沒背」,兩個都開就是兩個加起來 —— 配額
   (quotaPool ÷ 7)每次都拿這個現算,不是哪一天的快照,標分類、切
   toggle 當下就會反映在配額上。 */
function quotaPool() {
  return VOCAB_DATA.filter(e => tierOf(e.num) !== TIER_KNOWN && isVisible(e.num));
}
function roundQuota() {
  const n = quotaPool().length;
  return n ? Math.max(1, Math.ceil(n / QUOTA_DIVISOR)) : 0;
}
// 這一份背完、或想放棄重來,就按這個手動開始下一份 —— 沒有「日期」這回事,
// 想開幾份就開幾份,不用等隔天。
function startNextRound() {
  PROGRESS.dailySeen = [];
  saveProgress();
  renderHome();
}
function dailyDone() {
  return (PROGRESS.dailySeen || []).length;
}
function markSeenThisRound(num) {
  if (!PROGRESS.dailySeen) PROGRESS.dailySeen = [];
  if (!PROGRESS.dailySeen.includes(num)) {
    PROGRESS.dailySeen.push(num);
    saveProgress();
  }
}
function roundStats() {
  const quota = roundQuota();
  const done = dailyDone();
  return { quota, done, pct: quota ? Math.min(100, Math.round(done / quota * 100)) : 0 };
}

/* ---------- 日曆天統計(只給「近七天」用,跟上面的「份」完全獨立)----------
   使用者不要「每日進度」跟到日期的自動重設了,一份要背多少、什麼時候開始
   下一份全部是手動的。但「近七天有沒有練到」這種歷史紀錄還是有用,所以另外
   用 calSeen/calDate 記録「今天(日曆天)背過幾個字」,在背景自己跨日曆天
   歸零 —— 這只影響歷史顯示,不影響、也不會打斷正在背的那一份。 */
function markSeenToday(num) {
  const today = todayStr();
  if (PROGRESS.calDate && PROGRESS.calDate !== today) {
    recordDailyHistory(PROGRESS.calDate); // 把剛結束那天的最終次數存進歷史,再歸零
    PROGRESS.calSeen = [];
  }
  PROGRESS.calDate = today;
  if (!PROGRESS.calSeen) PROGRESS.calSeen = [];
  if (!PROGRESS.calSeen.includes(num)) PROGRESS.calSeen.push(num);
  recordDailyHistory();
}
// 把「今天(日曆天)」背了幾個字寫進歷史,配額用當下即時的 roundQuota 當參考值。
// 只留最近 30 天,存檔不會無限長大。
function recordDailyHistory(dateKey) {
  if (!PROGRESS.dailyHistory) PROGRESS.dailyHistory = {};
  PROGRESS.dailyHistory[dateKey || todayStr()] = { done: (PROGRESS.calSeen || []).length, quota: roundQuota() };
  const keys = Object.keys(PROGRESS.dailyHistory).sort();
  if (keys.length > 30) {
    for (const k of keys.slice(0, keys.length - 30)) delete PROGRESS.dailyHistory[k];
  }
}

// 整份進度(給首頁那一小條用):走到整份 A→Z 的哪裡了 = 看過的最後一個字
// 在「toggle 開著的所有單字」裡排第幾。只會往前不會倒退。
function bookProgress() {
  const visible = VOCAB_DATA.filter(x => isVisible(x.num));
  const total = visible.length;
  let maxNum = 0;
  for (const x of visible) if (x.num > maxNum && isSeen(x.num)) maxNum = x.num;
  const pos = visible.filter(x => x.num <= maxNum).length;
  return { pos, total, pct: total ? Math.round(pos / total * 100) : 0 };
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
    // 難字標記與分類兩邊取聯集,任何一邊操作過都保留。
    // 「已會」勝過「有印象」,免得同一個字兩邊標了不同類。
    chosen.star = !!(a.star || b.star);
    chosen.archived = !!(a.archived || b.archived);
    chosen.impress = !chosen.archived && !!(a.impress || b.impress);
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
function newList(pool) {
  return pool.filter(e => !isSeen(e.num));
}

// 整份進度:已會 = 完成,有印象 = 進行中,其餘 = 還沒背。
// 分母永遠是整本 1738,關 toggle 不影響這個數字。
function overallStats() {
  let known = 0, impress = 0;
  for (const e of VOCAB_DATA) {
    const t = tierOf(e.num);
    if (t === TIER_KNOWN) known++;
    else if (t === TIER_IMPRESS) impress++;
  }
  const total = VOCAB_DATA.length;
  return {
    known, impress, unlearned: total - known - impress, total,
    pct: Math.round(known / total * 100),
    pctTouched: Math.round((known + impress) / total * 100),
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- view management ---------- */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ---------- HOME ---------- */
function renderHome() {
  const r = roundStats();
  const book = bookProgress();

  // 大圓圈 = 這一份的進度(已背 / 這份配額),即時算,不是跟著日期走
  const circ = 326.7256;
  document.getElementById('ring-fg').style.strokeDashoffset = String(circ * (1 - r.pct / 100));
  document.getElementById('ring-pct').textContent = r.pct + '%';
  document.getElementById('ring-count').textContent = `這份 ${r.done} / ${r.quota}`;

  // 小小一條 = 整份進度(在整本 A→Z 裡走到哪了,跟「這一份」是不同的度量)
  document.getElementById('home-breakdown').innerHTML = `<span>整份<b>${book.pct}</b>%</span>`;

  // 三個分類各有幾個字,即時更新
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const e of VOCAB_DATA) counts[tierOf(e.num)]++;
  document.getElementById('home-count-known').textContent = counts[TIER_KNOWN];
  document.getElementById('home-count-impress').textContent = counts[TIER_IMPRESS];
  document.getElementById('home-count-new').textContent = counts[TIER_NEW];

  document.getElementById('stat-due').textContent = r.done;
  document.getElementById('stat-new').textContent = Math.max(0, r.quota - r.done);
  document.getElementById('stat-streak').textContent = PROGRESS.streak;

  document.getElementById('home-quota-note').textContent =
    r.quota ? `這份配額 ${r.quota} 張` : '有印象、還沒背都清空了 🎉';

  renderWeekStrip();
}

// 近七天:每天一個小圈,達標打勾、沒達標就畫出完成了幾分之幾的弧。這是日曆天的
// 統計(calSeen/dailyHistory),跟首頁圓圈那個「這一份」的進度是兩回事、互不影響 ——
// 一份可以橫跨好幾天、一天也可以背好幾份,近七天單純只看「那天總共背了幾個字」。
function renderWeekStrip() {
  const wrap = document.getElementById('week-strip');
  if (!wrap) return;
  const hist = PROGRESS.dailyHistory || {};
  const todayLive = { done: (PROGRESS.calSeen || []).length, quota: roundQuota() };
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const CIRC = 81.68; // 2π×13,跟 .week-ring-fg 的半徑對應
  let html = '';
  for (let i = 6; i >= 0; i--) {
    const d = addDaysStr(todayStr(), -i);
    const rec = i === 0 ? todayLive : (hist[d] || { done: 0, quota: 0 });
    const pct = rec.quota ? Math.min(1, rec.done / rec.quota) : 0;
    const hit = rec.quota > 0 && rec.done >= rec.quota;
    const label = i === 0 ? '今天' : WD[new Date(d + 'T00:00:00').getDay()];
    html +=
      `<div class="week-day${i === 0 ? ' today' : ''}">` +
        `<div class="week-ring-wrap">` +
          `<svg viewBox="0 0 32 32" class="week-ring">` +
            `<circle cx="16" cy="16" r="13" class="week-ring-bg"/>` +
            `<circle cx="16" cy="16" r="13" class="week-ring-fg" style="stroke-dashoffset:${CIRC * (1 - pct)}"/>` +
          `</svg>` +
          (hit ? `<svg class="week-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg>` : '') +
        `</div>` +
        `<span class="week-day-label">${label}</span>` +
      `</div>`;
  }
  wrap.innerHTML = html;
}

/* ---------- FLASHCARD SESSION (Reels 式上下滑瀏覽) ---------- */
let session = { queue: [], idx: 0, flipped: false };

function isArchived(num) { return !!getState(num).archived; }

/* 這一份:整本從頭往後掃,只收「目前分類 toggle 有開」而且這一份還沒算過的字。
   沒看過的排前面、看過的排後面;開了隨機順序就各自打亂。
   已算進這份的字會跳過,所以中途退出再進來是接續、不是重來。 */
function buildQueue(need) {
  need = need || Math.max(0, roundStats().quota - dailyDone());
  if (need <= 0) return [];
  const doneThisRound = new Set(PROGRESS.dailySeen || []);
  const pool = VOCAB_DATA.filter(e => isVisible(e.num) && !doneThisRound.has(e.num));
  let unseen = pool.filter(e => !isSeen(e.num));
  let seen = pool.filter(e => isSeen(e.num));
  if (PROGRESS.settings.shuffleOrder) { unseen = shuffle(unseen); seen = shuffle(seen); }
  return unseen.concat(seen).slice(0, need);
}

// 這一份已經看過的字(依 dailySeen 的順序)要接到佇列最前面,不然離開回首頁
// 再回來,buildQueue() 只會給「還沒算過」的新字,上滑找不到剛剛看過的那些卡了。
function seenThisRoundEntries() {
  return (PROGRESS.dailySeen || []).map(n => byNum[n]).filter(Boolean);
}

function startSession() {
  syncToggleUI();
  const seenEntries = seenThisRoundEntries();
  const q = seenEntries.concat(buildQueue());
  session = { queue: q, idx: Math.max(0, seenEntries.length - 1), flipped: false };
  if (q.length === 0) {
    const r = roundStats();
    if (r.quota === 0) {
      alert('沒有字可以背了。\n\n可能是都標成「已會」了,或是「還沒背」和「有印象」兩個分類都關掉了 —— 點右上角的設定開回來。');
    } else {
      alert(`這一份的 ${r.quota} 張都背完了!\n\n想開始下一份,回首頁按「開始下一份」。`);
    }
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

  document.getElementById('card-word').textContent = e.word;
  // 正面:單字 + 一句英文例句(例句原文是中英夾雜,中文那半要切掉才不會洩底)
  const frontEx = englishOnly((e.example || [])[0] || '');
  const frontExEl = document.getElementById('card-front-example');
  frontExEl.innerHTML = underlineTarget(frontEx, e.word);
  frontExEl.style.display = frontEx ? '' : 'none';
  document.getElementById('card-word-back').textContent = e.word;
  const rootBack = document.getElementById('card-root-back');
  rootBack.innerHTML = e.root
    ? '<b>' + escapeHtml(e.root) + '</b>' +
      (e.root_gloss ? '<span>' + escapeHtml(e.root_gloss) + '</span>' : '')
    : '';
  rootBack.style.display = e.root ? '' : 'none';
  const hookEl = document.getElementById('card-mnemonic');
  hookEl.textContent = e.mnemonic || '';
  hookEl.style.display = e.mnemonic ? '' : 'none';
  document.getElementById('card-zh').textContent = (e.meaning_zh || []).join('；');
  // 例句原文是「英文.中文」黏在一起的,拆成兩行才讀得下去
  document.getElementById('card-example').innerHTML = (e.example || []).map(x => {
    const en = englishOnly(x);
    const zh = x.slice(en.length).replace(/^[\s.,;:]+/, '').trim();
    return '<span class="ex-en">' + underlineTarget(en, e.word) + '</span>' +
      (zh ? '<span class="ex-zh">' + escapeHtml(zh) + '</span>' : '');
  }).join('');
  document.getElementById('card-example-wrap').style.display = (e.example || []).length ? '' : 'none';
  const synTokens = (e.synonyms || []).join(',').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  document.getElementById('card-syn').innerHTML =
    synTokens.map(s => '<span class="syn-chip">' + escapeHtml(s) + '</span>').join('');
  document.getElementById('card-syn-wrap').style.display = synTokens.length ? '' : 'none';

  syncActionButtons();
  exposeWord(e.num);          // 看過即標記
  markSeenThisRound(e.num);   // 算進這一份
  markSeenToday(e.num);       // 順便記進日曆天的歷史,給「近七天」用
  renderCardProgress();
}

// 背卡頁頂端進度條 = 這一份的進度(已背 / 這份配額),中途退出再進來會接續
function renderCardProgress() {
  const r = roundStats();
  document.getElementById('session-progress-fill').style.width = r.pct + '%';
  document.getElementById('session-progress-count').textContent = `${r.done} / ${r.quota}`;
  document.getElementById('session-progress-pct').textContent = r.pct + '%';
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* example 欄位是「English sentence. 中文翻譯。」黏在同一個字串裡。
   正面只能給英文,不然翻譯等於先把答案送出去。
   取第一個中日文字元之前的部分;切出來太短(整句是中文開頭之類的特例)
   就退回「把中文字元全部挖掉」。 */
/* 例句裡的目標字畫底線。句子裡多半是變化形(exacerbate → exacerbates、
   grandiloquence → grandiloquent、illiteracy → illiterate),所以由嚴到寬試:
   原形 → 去掉字尾 e/y/d/s → 取前 60% 當字首,後面允許接任何字尾字母。
   全部抓不到就整句原樣輸出(1738 條裡剩下的都是資料本身拼錯或英美拼法不同)。 */
function underlineTarget(sentence, word) {
  if (!sentence) return '';
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stems = [word];
  if (/[eyds]$/i.test(word)) stems.push(word.slice(0, -1));
  const cut = Math.max(4, Math.ceil(word.length * 0.6));
  if (cut < word.length) stems.push(word.slice(0, cut));
  for (const stem of stems) {
    if (stem.length < 3) continue;
    const re = new RegExp('(^|[^\\p{L}])(' + esc(stem) + "[\\p{L}']*)", 'iu');
    const m = sentence.match(re);
    if (!m) continue;
    const start = m.index + m[1].length;
    return escapeHtml(sentence.slice(0, start)) +
      '<u class="ex-target">' + escapeHtml(m[2]) + '</u>' +
      escapeHtml(sentence.slice(start + m[2].length));
  }
  return escapeHtml(sentence);
}

const CJK_RE = /[一-鿿　-〿＀-￯]/;
function englishOnly(s) {
  if (!s) return '';
  const i = s.search(CJK_RE);
  let en = (i === -1 ? s : s.slice(0, i)).trim();
  if (en.length < 12) {
    en = s.replace(new RegExp(CJK_RE.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
  }
  return en;
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

// 兩顆分類按鈕會亮起來表示這張卡目前是哪一類,按第二次可以取消(按錯救得回來)
function syncActionButtons() {
  const e = currentEntry();
  const t = e ? tierOf(e.num) : TIER_NEW;
  document.getElementById('btn-impress').classList.toggle('on', t === TIER_IMPRESS);
  document.getElementById('btn-archive').classList.toggle('on', t === TIER_KNOWN);
  // 卡面左邊那條分類色條(見 style.css 的 .card-face::before),還沒背不畫線
  const card = document.getElementById('flashcard');
  card.classList.toggle('tier-impress', t === TIER_IMPRESS);
  card.classList.toggle('tier-known', t === TIER_KNOWN);
}

/* ---------- 設定(統計頁 + 背卡頁右上角面板共用同一組) ---------- */
const SETTING_SWITCHES = [
  ['toggle-show-new', 'showNew'], ['toggle-show-impress', 'showImpress'], ['toggle-show-known', 'showKnown'],
  ['toggle-default-flip', 'defaultFlipped'], ['toggle-shuffle', 'shuffleOrder'],
  ['panel-show-new', 'showNew'], ['panel-show-impress', 'showImpress'], ['panel-show-known', 'showKnown'],
  ['panel-flip', 'defaultFlipped'],
];
function syncToggleUI() {
  for (const [id, key] of SETTING_SWITCHES) {
    const el = document.getElementById(id);
    if (el) el.setAttribute('aria-checked', String(!!PROGRESS.settings[key]));
  }
}
const TIER_VISIBILITY_KEYS = ['showNew', 'showImpress', 'showKnown'];
function setSetting(key, val) {
  PROGRESS.settings[key] = val;
  // 配額是即時算的(roundQuota),切分類 toggle 不用額外做什麼,
  // 下一次 renderHome / renderCardProgress 就會反映新的數字。
  saveProgress();
  syncToggleUI();
  renderHome();
  const inSession = document.getElementById('view-session').classList.contains('active');
  if (inSession && key === 'defaultFlipped') {
    // 立刻套到眼前這張卡,不用等下一張
    session.flipped = val;
    document.getElementById('flashcard').classList.toggle('flipped', val);
  } else if (inSession && TIER_VISIBILITY_KEYS.includes(key)) {
    refreshSessionQueue();
  }
  if (document.getElementById('view-stats').classList.contains('active')) renderStats();
}

// toggle 分類後,把這回合的佇列整個重排 = 這回合已經看過的字(順序不變,保留上滑
// 回顧的能力)+ 目前所有「有開的分類 + 今天還沒算過」的字。沒看過的排前面、看過
// 的(含有印象)排後面。這裡不套每日配額 —— 使用者主動開了某類,就是要看到那類
// 的全部;要停隨時退出。
function refreshSessionQueue() {
  if (!session.queue.length) return;
  const curNum = currentEntry() ? currentEntry().num : null;
  const seenEntries = seenThisRoundEntries();
  const doneToday = new Set(PROGRESS.dailySeen || []);
  const pool = VOCAB_DATA.filter(e => isVisible(e.num) && !doneToday.has(e.num));
  let unseen = pool.filter(e => !isSeen(e.num));
  let seen = pool.filter(e => isSeen(e.num));
  if (PROGRESS.settings.shuffleOrder) { unseen = shuffle(unseen); seen = shuffle(seen); }
  const q = seenEntries.concat(unseen, seen);
  if (q.length === 0) { finishSession(); return; }
  session.queue = q;
  const i = q.findIndex(e => e.num === curNum);
  session.idx = i >= 0 ? i : Math.min(session.idx, q.length - 1);
  renderCard();
}

function markCurrent(tier) {
  // 過場動畫還在跑的時候別接受第二次點擊,不然會標到已經換掉的那張卡
  if (swapping) return;
  const e = currentEntry();
  if (!e) return;
  // 再按一次同一顆 = 退回「還沒背」
  const next = tierOf(e.num) === tier ? TIER_NEW : tier;
  setTier(e.num, next);
  // 標成一個現在關著的分類,這張卡就當場從這回合抽掉;否則留著,直接換下一張
  if (!tierVisible(next)) {
    session.queue.splice(session.idx, 1);
    if (session.queue.length === 0) { finishSession(); return; }
    if (session.idx >= session.queue.length) session.idx = session.queue.length - 1;
    flySwap('up', () => renderCard());
    return;
  }
  syncActionButtons();
  renderCardProgress();
  if (next !== TIER_NEW) nextCard();
}

function finishSession() {
  const r = roundStats();
  const remaining = quotaPool().length;
  const known = VOCAB_DATA.filter(e => tierOf(e.num) === TIER_KNOWN).length;
  const impress = VOCAB_DATA.filter(e => tierOf(e.num) === TIER_IMPRESS).length;
  // 只有真的背完這一份才慶祝;半路先跑掉就低調帶過
  const hit = r.done >= r.quota;
  document.getElementById('done-emoji').textContent = hit ? '🎉' : '👍';
  document.getElementById('done-title').textContent = hit ? '這一份背完了！' : '先看到這裡';
  document.getElementById('done-stats').innerHTML =
    `這份進度 <b>${r.done} / ${r.quota}</b> 張` +
    (hit ? '' : `<br>再 <b>${Math.max(0, r.quota - r.done)}</b> 張就到這份的目標了`) +
    `<br>整份還沒搞定 <b>${remaining}</b> 字` +
    `<br>✓ 已會 <b>${known}</b> ・ 🤔 有印象 <b>${impress}</b>`;
  document.getElementById('btn-done-next').style.display = remaining ? '' : 'none';
  showView('view-done');
}

/* ---------- 看過即標記 ---------- */
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

/* ---------- STATS VIEW ---------- */
function renderStats() {
  const o = overallStats();
  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-chip"><span>${o.known}</span><label>✓ 已會 / ${o.total}</label></div>
    <div class="stat-chip"><span>${o.pct}%</span><label>整份進度</label></div>
    <div class="stat-chip"><span>${o.impress}</span><label>🤔 有印象</label></div>
    <div class="stat-chip"><span>${PROGRESS.streak}</span><label>🔥 連續天數</label></div>
  `;

  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const e of VOCAB_DATA) counts[tierOf(e.num)]++;
  document.getElementById('count-new').textContent = counts[TIER_NEW];
  document.getElementById('count-impress').textContent = counts[TIER_IMPRESS];
  document.getElementById('count-known').textContent = counts[TIER_KNOWN];

  syncToggleUI();
  document.getElementById('btn-undo-reset').style.display = localStorage.getItem(RESET_BACKUP_KEY) ? '' : 'none';
  renderSearchList();
  renderSyncUI();
}

/* ---------- 單字搜尋 / 分類管理 ---------- */
let searchFilter = 'all';
const SEARCH_LIMIT = 60;

function renderSearchList() {
  const wrap = document.getElementById('search-list');
  const q = document.getElementById('word-search').value.trim().toLowerCase();
  let hits = VOCAB_DATA;
  if (searchFilter !== 'all') hits = hits.filter(e => tierOf(e.num) === Number(searchFilter));
  if (q) {
    hits = hits.filter(e =>
      e.word.toLowerCase().includes(q) ||
      (e.root || '').toLowerCase().includes(q) ||
      (e.meaning_zh || []).join('；').includes(q));
  } else if (searchFilter === 'all') {
    // 沒打字又沒選分類就別把 1738 個字全倒出來
    wrap.innerHTML = '<div class="archived-empty">打字搜尋，或點上面的分類看清單。</div>';
    return;
  }

  wrap.innerHTML = '';
  if (hits.length === 0) {
    wrap.innerHTML = '<div class="archived-empty">找不到符合的字。</div>';
    return;
  }
  for (const e of hits.slice(0, SEARCH_LIMIT)) {
    const t = tierOf(e.num);
    const row = document.createElement('div');
    row.className = 'search-row';
    row.innerHTML =
      `<div class="sr-main"><span class="aw">${escapeHtml(e.word)}</span>` +
      `<span class="az">${escapeHtml((e.meaning_zh || []).join('；'))}</span></div>` +
      `<div class="sr-tiers">` +
      [TIER_NEW, TIER_IMPRESS, TIER_KNOWN].map(v =>
        `<button class="tier-btn${v === t ? ' on' : ''}" data-tier="${v}">${TIER_LABEL[v]}</button>`).join('') +
      `</div>`;
    row.querySelectorAll('.tier-btn').forEach(btn => {
      btn.onclick = () => {
        setTier(e.num, Number(btn.dataset.tier));
        renderStats();
        renderHome();
      };
    });
    wrap.appendChild(row);
  }
  if (hits.length > SEARCH_LIMIT) {
    const more = document.createElement('div');
    more.className = 'archived-empty';
    more.textContent = `共 ${hits.length} 筆，先顯示前 ${SEARCH_LIMIT} 筆 —— 再打幾個字縮小範圍。`;
    wrap.appendChild(more);
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
document.getElementById('btn-new-day').onclick = () => {
  // 已經背完這份、或還沒背的話不用問;只有背了一半還沒到配額才確認一下,
  // 免得手滑把還沒背完的那份洗掉
  const r = roundStats();
  if (r.done > 0 && r.done < r.quota &&
      !confirm(`這份已經背了 ${r.done} / ${r.quota} 張,還沒到目標。\n\n確定要放棄、直接開始下一份嗎？（分類和背過的紀錄都不受影響）`)) return;
  startNextRound();
};
document.getElementById('btn-stats').onclick = () => { renderStats(); showView('view-stats'); };
document.getElementById('btn-exit-stats').onclick = () => { showView('view-home'); renderHome(); };

const sessionPanel = document.getElementById('session-panel');
function closeSessionPanel() { sessionPanel.hidden = true; }
document.getElementById('btn-session-settings').onclick = (ev) => {
  ev.stopPropagation();
  sessionPanel.hidden = !sessionPanel.hidden;
};
document.addEventListener('click', (ev) => {
  if (!sessionPanel.hidden && !sessionPanel.contains(ev.target) &&
      ev.target.closest('#btn-session-settings') === null) closeSessionPanel();
});

document.getElementById('btn-exit-session').onclick = () => {
  window.speechSynthesis && window.speechSynthesis.cancel();
  closeSessionPanel();
  showView('view-home'); renderHome();
};
document.getElementById('flashcard').onclick = flipCard;
document.getElementById('btn-impress').onclick = (ev) => {
  ev.stopPropagation();
  markCurrent(TIER_IMPRESS);
};
document.getElementById('btn-archive').onclick = (ev) => {
  ev.stopPropagation();
  markCurrent(TIER_KNOWN);
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

// 「開始下一份」:歸零重來,馬上背下一份(份量用當下即時重算的配額)
document.getElementById('btn-done-next').onclick = () => {
  PROGRESS.dailySeen = [];
  saveProgress();
  const q = buildQueue(roundQuota());
  if (q.length === 0) { showView('view-home'); renderHome(); return; }
  session = { queue: q, idx: 0, flipped: false };
  showView('view-session');
  renderCard();
};
document.getElementById('btn-done-home').onclick = () => { showView('view-home'); renderHome(); };

document.getElementById('btn-export').onclick = exportProgress;
document.getElementById('btn-import').onclick = () => document.getElementById('import-file').click();
document.getElementById('import-file').onchange = (ev) => {
  if (ev.target.files[0]) importProgress(ev.target.files[0]);
};
const RESET_BACKUP_KEY = 'lgv_last_reset_backup_v1';

document.getElementById('btn-reset').onclick = () => {
  if (confirm('確定要重置背誦進度嗎？\n\n「✓ 已會」和「🤔 有印象」的分類完全不會受影響。\n這個動作會留一份備份，如果按錯了可以在下面「復原上次重置」救回來。')) {
    // 重置前先留一份完整快照,讓「復原上次重置」有東西可還原
    localStorage.setItem(RESET_BACKUP_KEY, JSON.stringify(PROGRESS));

    // 只重置學習進度(box/due/reps/seen),分類(archived / impress)整包保留
    const keptTiers = {};
    for (const [num, st] of Object.entries(PROGRESS.words || {})) {
      if (st.archived) keptTiers[num] = { archived: true, seen: true };
      else if (st.impress) keptTiers[num] = { impress: true, seen: true };
    }
    const fresh = defaultProgress();
    fresh.settings = Object.assign(fresh.settings, PROGRESS.settings || {});
    fresh.words = keptTiers;
    PROGRESS = fresh;
    saveProgress();
    renderStats();
    renderHome();
  }
};

document.getElementById('btn-undo-reset').onclick = () => {
  const raw = localStorage.getItem(RESET_BACKUP_KEY);
  if (!raw) return;
  if (confirm('確定要復原成上次重置前的進度嗎？')) {
    try {
      PROGRESS = Object.assign(defaultProgress(), JSON.parse(raw));
      saveProgress();
      localStorage.removeItem(RESET_BACKUP_KEY);
      renderStats();
      renderHome();
      alert('已復原！');
    } catch (e) {
      alert('備份資料損毀，無法復原。');
    }
  }
};

// 統計頁與背卡面板的所有 toggle 走同一條路:改設定 → 同步兩邊 UI → 需要時重整佇列
for (const [id, key] of SETTING_SWITCHES) {
  const el = document.getElementById(id);
  if (el) el.onclick = () => setSetting(key, !PROGRESS.settings[key]);
}

document.getElementById('word-search').oninput = renderSearchList;
document.querySelectorAll('#tier-filter .tier-chip').forEach(chip => {
  chip.onclick = () => {
    searchFilter = chip.dataset.tier;
    document.querySelectorAll('#tier-filter .tier-chip').forEach(c => c.classList.toggle('active', c === chip));
    renderSearchList();
  };
});

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
syncToggleUI();
renderHome();
pullSyncOnLoad().then(() => {
  // only refresh the visible screen; don't yank the user out of an active session
  if (document.querySelector('.view.active').id === 'view-home') renderHome();
});
