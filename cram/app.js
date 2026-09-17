/* ---------- 考前衝刺版:簡化版 ----------
   只留兩件事:一條「全部背起來了多少」的進度條,跟卡片上「背起來了」這一顆按鈕。
   跟原本正式版比,拿掉了三分類/配額/近七天/連續天數/同步/搜尋分類等等 —— 這是
   暫時衝刺用的,考完就整個 cram/ 資料夾砍掉,不需要那麼多功能。 */
const STORAGE_KEY = 'lgv_cram_progress_v1';

const byNum = {};
for (const e of VOCAB_DATA) byNum[e.num] = e;

function defaultProgress() {
  return {
    memorized: [],   // 已經「背起來了」的 num 清單
    settings: { defaultFlipped: false },
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
    if (!Array.isArray(merged.memorized)) merged.memorized = [];
    return merged;
  } catch (e) {
    return defaultProgress();
  }
}
function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(PROGRESS));
}

function isMemorized(num) { return PROGRESS.memorized.includes(num); }
function setMemorized(num, val) {
  const i = PROGRESS.memorized.indexOf(num);
  if (val && i === -1) PROGRESS.memorized.push(num);
  if (!val && i !== -1) PROGRESS.memorized.splice(i, 1);
  saveProgress();
}

function overallProgress() {
  const total = VOCAB_DATA.length;
  const done = PROGRESS.memorized.length;
  return { done, total, pct: total ? Math.round(done / total * 100) : 0 };
}

/* ---------- view management ---------- */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ---------- HOME ---------- */
function renderHome() {
  const p = overallProgress();
  const circ = 326.7256;
  document.getElementById('ring-fg').style.strokeDashoffset = String(circ * (1 - p.pct / 100));
  document.getElementById('ring-pct').textContent = p.pct + '%';
  document.getElementById('ring-count').textContent = `${p.done} / ${p.total}`;
  document.getElementById('home-note').textContent =
    p.done >= p.total ? '全部背起來了 🎉' : `還剩 ${p.total - p.done} 個字`;
}

/* ---------- FLASHCARD SESSION (Reels 式上下滑瀏覽) ---------- */
let session = { queue: [], idx: 0, flipped: false };

function buildQueue() {
  return VOCAB_DATA.filter(e => !isMemorized(e.num));
}

function startSession() {
  const q = buildQueue();
  session = { queue: q, idx: 0, flipped: false };
  if (q.length === 0) {
    alert('全部背起來了！🎉');
    return;
  }
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

  syncActionButton();
  renderCardProgress();
}

function renderCardProgress() {
  const p = overallProgress();
  document.getElementById('session-progress-fill').style.width = p.pct + '%';
  document.getElementById('session-progress-count').textContent = `${p.done} / ${p.total}`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

// 唯一的分類按鈕:「背起來了」,亮起來表示這張卡已經標記過;再按一次可以取消
function syncActionButton() {
  const e = currentEntry();
  const on = e ? isMemorized(e.num) : false;
  document.getElementById('btn-memorized').classList.toggle('on', on);
}

function markCurrent() {
  if (swapping) return;
  const e = currentEntry();
  if (!e) return;
  const next = !isMemorized(e.num);
  setMemorized(e.num, next);
  // 標成「背起來了」就從這輪佇列抽掉;取消標記則留著
  if (next) {
    session.queue.splice(session.idx, 1);
    if (session.queue.length === 0) { finishSession(); return; }
    if (session.idx >= session.queue.length) session.idx = session.queue.length - 1;
    flySwap('up', () => renderCard());
    return;
  }
  syncActionButton();
  renderCardProgress();
}

function finishSession() {
  const p = overallProgress();
  const hit = p.done >= p.total;
  document.getElementById('done-emoji').textContent = hit ? '🎉' : '👍';
  document.getElementById('done-title').textContent = hit ? '全部背起來了！' : '先看到這裡';
  document.getElementById('done-stats').innerHTML =
    `目前進度 <b>${p.done} / ${p.total}</b> 字`;
  document.getElementById('btn-done-next').style.display = (p.total - p.done) ? '' : 'none';
  showView('view-done');
}

/* ---------- init ---------- */
renderHome();

/* ---------- wiring ---------- */
document.getElementById('btn-start-session').onclick = startSession;
document.getElementById('btn-exit-session').onclick = () => {
  window.speechSynthesis && window.speechSynthesis.cancel();
  showView('view-home'); renderHome();
};
document.getElementById('flashcard').onclick = flipCard;
document.getElementById('btn-memorized').onclick = (ev) => {
  ev.stopPropagation();
  markCurrent();
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
document.getElementById('btn-done-next').onclick = () => {
  const q = buildQueue();
  if (q.length === 0) { showView('view-home'); renderHome(); return; }
  session = { queue: q, idx: 0, flipped: false };
  showView('view-session');
  renderCard();
};
document.getElementById('btn-done-home').onclick = () => { showView('view-home'); renderHome(); };

document.getElementById('btn-reset').onclick = () => {
  if (confirm('確定要清空「背起來了」的紀錄,全部字重新開始嗎？')) {
    PROGRESS = defaultProgress();
    saveProgress();
    renderHome();
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
  let mode = null;
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
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) { mode = 'none'; return; }
      mode = backCanScroll(dy < 0) ? 'scroll' : 'swipe';
    }
    if (mode !== 'swipe') return;
    ev.preventDefault();
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
