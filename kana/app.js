/* ひらがな flashcard
   - 「背到哪一行」:點某一行,從あ行到那一行全部打開,後面的不出現。
   - 一顆「記得了」:標記後直接滑下一張,從佇列移除;沒標記的字會一直輪回來,
     直到範圍內全部記得。進度條 = 範圍內記得了幾個。 */
const STORAGE_KEY = 'lgv_kana_progress_v1';

function defaultProgress() {
  return {
    known: [],          // 已經按過「記得了」的假名
    upto: 4,            // 背到第幾行(ROWS 的索引),0..upto 都打開
    settings: { ordered: false, autoSpeak: true, review: false },
  };
}

let PROGRESS = loadProgress();

function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!p) return defaultProgress();
    const d = defaultProgress();
    const m = Object.assign(d, p);
    m.settings = Object.assign(d.settings, p.settings || {});
    if (!Array.isArray(m.known)) m.known = [];
    if (!Number.isInteger(m.upto) || m.upto < 0 || m.upto >= ROWS.length) m.upto = d.upto;
    return m;
  } catch (e) {
    return defaultProgress();
  }
}
function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(PROGRESS));
}

const isKnown = (k) => PROGRESS.known.includes(k);
function setKnown(k, val) {
  const i = PROGRESS.known.indexOf(k);
  if (val && i === -1) PROGRESS.known.push(k);
  if (!val && i !== -1) PROGRESS.known.splice(i, 1);
  saveProgress();
}

const inRange = () => KANA.filter(e => e.row <= PROGRESS.upto);
function progress() {
  const pool = inRange();
  const done = pool.filter(e => isKnown(e.kana)).length;
  return { done, total: pool.length, pct: pool.length ? Math.round(done / pool.length * 100) : 0 };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildQueue() {
  let q = inRange().filter(e => PROGRESS.settings.review || !isKnown(e.kana));
  if (!PROGRESS.settings.ordered) q = shuffle(q);
  return q;
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- HOME ---------- */
const SWITCHES = [['toggle-speak', 'autoSpeak'], ['toggle-ordered', 'ordered'], ['toggle-review', 'review']];

function renderHome() {
  const p = progress();
  const circ = 326.7256;
  document.getElementById('ring-fg').style.strokeDashoffset = String(circ * (1 - p.pct / 100));
  document.getElementById('ring-pct').textContent = p.pct + '%';
  document.getElementById('ring-count').textContent = `${p.done} / ${p.total}`;

  document.getElementById('row-chips').innerHTML = ROWS.map((name, i) =>
    `<button class="row-chip${i <= PROGRESS.upto ? ' on' : ''}${i === PROGRESS.upto ? ' edge' : ''}" data-row="${i}">${name}</button>`
  ).join('');
  document.querySelectorAll('.row-chip').forEach(chip => {
    chip.onclick = () => {
      PROGRESS.upto = Number(chip.dataset.row);
      saveProgress();
      renderHome();
    };
  });

  for (const [id, key] of SWITCHES) {
    document.getElementById(id).setAttribute('aria-checked', String(!!PROGRESS.settings[key]));
  }
}
for (const [id, key] of SWITCHES) {
  document.getElementById(id).onclick = () => {
    PROGRESS.settings[key] = !PROGRESS.settings[key];
    saveProgress();
    renderHome();
  };
}

/* ---------- SESSION ---------- */
let session = { queue: [], idx: 0, flipped: false };
const currentEntry = () => session.queue[session.idx];

function startSession() {
  const q = buildQueue();
  if (q.length === 0) {
    alert('這個範圍全部都記得了!🎉\n\n想再複習可以打開「也複習已經記得的」,或選更後面的行。');
    return;
  }
  session = { queue: q, idx: 0, flipped: false };
  showView('view-session');
  renderCard();
}

function renderCard() {
  const e = currentEntry();
  if (!e) { finishSession(); return; }
  session.flipped = false;
  document.getElementById('flashcard').classList.remove('revealed');
  document.getElementById('card-word').textContent = e.kana;
  document.getElementById('card-romaji').textContent = e.romaji;

  const hasEx = !!e.word;
  document.getElementById('card-example-wrap').style.visibility = hasEx ? '' : 'hidden';
  if (hasEx) {
    // 例字裡把這個假名畫底線
    document.getElementById('card-ex-word').textContent = e.word;
    document.getElementById('card-ex-sub').textContent = `${e.wr} · ${e.zh}`;
  }
  document.getElementById('btn-memorized').classList.toggle('on', isKnown(e.kana));
  renderCardProgress();
}

function renderCardProgress() {
  const p = progress();
  document.getElementById('session-progress-fill').style.width = p.pct + '%';
  document.getElementById('session-progress-count').textContent = `${p.done} / ${p.total}`;
}

function speak() {
  const e = currentEntry();
  if (!e || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(e.kana);
  u.lang = 'ja-JP'; u.rate = 0.8;
  window.speechSynthesis.speak(u);
}

function flipCard() {
  session.flipped = !session.flipped;
  document.getElementById('flashcard').classList.toggle('revealed', session.flipped);
  if (session.flipped && PROGRESS.settings.autoSpeak) speak();
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

// 佇列是循環的:滑到最後一張再往下就繞回第一張,沒記得的字會一直輪回來
// 預設是隨機順序;繞完一圈回到開頭時重新洗牌,才不會第二圈又變成固定順序
function step(dir) {
  const q = session.queue, n = q.length;
  if (dir > 0 && session.idx === n - 1 && !PROGRESS.settings.ordered) {
    const cur = q[session.idx];
    let s = shuffle(q);
    if (s[0] === cur && n > 1) [s[0], s[1]] = [s[1], s[0]];
    session.queue = s;
    session.idx = 0;
  } else {
    session.idx = (session.idx + dir + n) % n;
  }
}
function nextCard() {
  if (session.queue.length < 2) return;
  flySwap('up', () => { step(1); renderCard(); });
}
function prevCard() {
  if (session.queue.length < 2) return;
  flySwap('down', () => { step(-1); renderCard(); });
}

function markCurrent() {
  if (swapping) return;
  const e = currentEntry();
  if (!e) return;
  const next = !isKnown(e.kana);
  setKnown(e.kana, next);
  if (!next) { document.getElementById('btn-memorized').classList.remove('on'); renderCardProgress(); return; }
  if (PROGRESS.settings.review) { renderCardProgress(); nextCard(); return; }
  // 記得了 → 從佇列抽掉,idx 不動就剛好是下一張(到底就繞回第一張)
  session.queue.splice(session.idx, 1);
  if (session.queue.length === 0) { finishSession(); return; }
  if (session.idx >= session.queue.length) session.idx = 0;
  flySwap('up', () => renderCard());
}

function finishSession() {
  const p = progress();
  document.getElementById('done-stats').innerHTML = `記得了 <b>${p.done} / ${p.total}</b> 個`;
  showView('view-done');
}

/* ---------- wiring ---------- */
document.getElementById('btn-start-session').onclick = startSession;
document.getElementById('btn-exit-session').onclick = () => {
  window.speechSynthesis && window.speechSynthesis.cancel();
  showView('view-home'); renderHome();
};
document.getElementById('btn-done-home').onclick = () => { showView('view-home'); renderHome(); };
document.getElementById('flashcard').onclick = flipCard;
document.getElementById('btn-memorized').onclick = (ev) => { ev.stopPropagation(); markCurrent(); };
document.getElementById('btn-speak').onclick = (ev) => { ev.stopPropagation(); speak(); };
document.getElementById('btn-reset').onclick = () => {
  if (confirm('確定要清空所有「記得了」的紀錄嗎?')) {
    PROGRESS.known = [];
    saveProgress();
    renderHome();
  }
};

document.addEventListener('keydown', (ev) => {
  if (!document.getElementById('view-session').classList.contains('active')) return;
  if (ev.code === 'Space') { ev.preventDefault(); flipCard(); }
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') { ev.preventDefault(); nextCard(); }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') { ev.preventDefault(); prevCard(); }
});

/* 跟手滑動:放手依距離/速度決定甩出或彈回;背面內容可捲動時先讓它捲 */
(function () {
  const stage = document.querySelector('.card-stage');
  const sw = document.getElementById('card-swiper');
  let sx = 0, sy = 0, lastY = 0, lastT = 0, vel = 0, mode = null, dragging = false;

  function backCanScroll() { return false; }

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
    sw.style.transform = `translateY(${dy}px)`;
    sw.style.opacity = String(Math.max(0.4, 1 - Math.abs(dy) / 600));
  }, { passive: false });

  stage.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    if (mode !== 'swipe') { mode = null; sw.style.transition = ''; return; }
    mode = null;
    const dy = lastY - sy;
    const commit = (Math.abs(dy) > 90 || Math.abs(vel) > 0.55) && session.queue.length > 1;
    if (!commit) { springBack(); return; }
    const up = dy < 0;
    finishDrag(up ? 'up' : 'down', () => {
      step(up ? 1 : -1);
      renderCard();
    });
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

renderHome();
