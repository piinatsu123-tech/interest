'use strict';
/* =========================================================
   focusflow.js — FocusFlow タスクシステム (本アプリのメイン機能)
   piinatsu123-tech/focusflow1 v5.2 を移植。
   - DOM: index.html 内の #tab-tasks (メイン) と #ffx-overlays (サブ画面)
   - データ: localStorage 'ff-tasks' (FocusFlow と同一形式 + 手番用の order)
   - 公開: window.FFX (inline onclick と triage.js 連携用)
   - 変更点: クラス/ID に ffx- プレフィックス、ヘッダー＋ボタンからの新規作成、
     serviceWorker 登録なし、今日中(must)タスクの手番の並べ替え
   ========================================================= */
(function () {

// ─── HELPERS ─────────────────────────────────────────────────────
// stepのラベル（新: text / 旧: title / 文字列）
function stepLabel(s) {
  if (typeof s === 'string') return s;
  return s.text || s.title || '';
}
// stepの見積もり分数
function stepMinutes(s) {
  if (!s || typeof s !== 'object') return 0;
  return s.estimatedMinutes || 0;
}
// タスク全体の見積もり（stepsの合計 or t.estimate）
function taskEstimate(t) {
  const fromSteps = (t.steps || []).reduce((sum, s) => sum + stepMinutes(s), 0);
  return fromSteps > 0 ? fromSteps : (t.estimate || 30);
}

// ─── MIGRATION ───────────────────────────────────────────────────
function migrateTasks(list) {
  const urgencyMap  = { must: 'must', want: 'want', idea: 'nice' };
  const priorityMap = { high: 'must', medium: 'want', low: 'nice' };
  return list.map((t, i) => {
    if (!t.id) t.id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    if (!t.title && t.text) t.title = t.text; // 旧形式/外部形式の正規化
    t.done    = t.done || false;
    t.urgency = t.urgency || urgencyMap[t.type] || priorityMap[t.priority] || 'want';
    // 手動並べ替え用の順序 (無ければ配列位置を初期値に。表示順を変えないため)
    if (typeof t.order !== 'number') t.order = i;
    // steps を内部フォーマット（text/done/estimatedMinutes）に統一
    t.steps = (t.steps || []).map(s => typeof s === 'string'
      ? { text: s, done: false, estimatedMinutes: 0 }
      : { text: s.text || s.title || '', done: s.done || false,
          estimatedMinutes: s.estimatedMinutes || 0 });
    t.estimate = taskEstimate(t);
    return t;
  });
}

// ─── VERSION ─────────────────────────────────────────────────────
const APP_VERSION = 'v6.0';

// ─── STATE ───────────────────────────────────────────────────────
let tasks = migrateTasks(JSON.parse(localStorage.getItem('ff-tasks') || '[]'));
let currentUrgency = null;
let reorderMode    = false; // 今日中(must)グループの並べ替えモード
let reorderTapSeq  = [];    // 並べ替えモード中にタップした順の id 一覧
let focusId        = null;
let timerTotal     = 0;
let timerLeft      = 0;
let timerRunning   = false;
let timerTick      = null;

const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const save = () => {
  localStorage.setItem('ff-tasks', JSON.stringify(tasks));
  // Workerにアクティブタスクを同期（一覧コマンド用）
  fetch('https://divine-wildflower-8952.piinatsu123.workers.dev/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks })
  }).catch(() => {});
};
const esc  = s => String(s||'').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// IDの重複を修復（LINE取り込みの衝突対策）
(function deduplicateIds() {
  const seen = new Set();
  let changed = false;
  tasks.forEach(t => {
    if (!t.id || seen.has(t.id)) {
      t.id = uid();
      changed = true;
    }
    seen.add(t.id);
  });
  if (changed) localStorage.setItem('ff-tasks', JSON.stringify(tasks));
})();

// 手番の番号表示 (①②③…)。21件目以降は "(21)" のようにフォールバック
const CIRCLED_DIGITS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'.split('');
function circledNumber(n) { return CIRCLED_DIGITS[n - 1] || `(${n})`; }

const GROUP_CONFIG = [
  { urgency: 'must', title: '今日中に絶対' },
  { urgency: 'want', title: 'できたらやりたい' },
  { urgency: 'nice', title: '余力があれば' },
  { urgency: 'scheduled', title: '後日実行予定' },
];

// ─── TOAST ───────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

// ─── TIME BAR ────────────────────────────────────────────────────
function calcTimeBar() {
  const active = t => t.urgency !== 'scheduled';
  const totalMin = tasks.filter(active).reduce((s, t) => s + taskEstimate(t), 0);
  const remMin   = tasks.filter(t => !t.done && active(t)).reduce((s, t) => s + taskEstimate(t), 0);
  const doneMin  = totalMin - remMin;
  document.getElementById('timeBarRemaining').textContent = (remMin / 60).toFixed(1);
  document.getElementById('timeBarTotal').textContent     = '/ ' + (totalMin / 60).toFixed(1) + 'h';
  document.getElementById('timeBarFill').style.width      =
    (totalMin > 0 ? Math.round(doneMin / totalMin * 100) : 0) + '%';
}

// ─── MAIN SCREEN ─────────────────────────────────────────────────
function renderMain() {
  autoPromoteScheduled();
  document.getElementById('dateBadge').textContent =
    new Date().toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', weekday: 'short' });
  document.getElementById('versionBadge').textContent = APP_VERSION;
  calcTimeBar();

  const incomplete = tasks.filter(t => !t.done);
  const el = document.getElementById('mainGroups');

  if (!incomplete.length) {
    el.innerHTML = `<div class="empty-state"><span class="icon">✓</span><p>すべてのタスクが完了しました！</p></div>`;
    return;
  }

  let html = '';
  GROUP_CONFIG.forEach(({ urgency, title }) => {
    const list   = tasks.filter(t => !t.done && t.urgency === urgency);
    const count  = list.length;
    const estMin = list.reduce((s, t) => s + taskEstimate(t), 0);
    const estStr = count > 0
      ? (estMin >= 60 ? (estMin / 60).toFixed(1) + 'h' : estMin + '分')
      : '';
    const zeroClass  = count === 0 ? ' zero' : '';
    const mustClass  = urgency === 'must' && count > 0 ? ' must-color' : '';
    const scheduledClass = urgency === 'scheduled' && count > 0 ? ' scheduled-color' : '';
    const clickAttr  = count > 0 ? `onclick="FFX.showGroup('${urgency}')"` : '';

    html += `
    <div class="group-row${zeroClass}" ${clickAttr}>
      <div class="gr-label">
        <div class="gr-title${mustClass}${scheduledClass}">${title}</div>
        ${estStr ? `<div class="gr-est">${estStr}</div>` : ''}
      </div>
      <div class="gr-right">
        <div class="gr-count${mustClass}${scheduledClass}">${count}</div>
        <div class="gr-unit">件</div>
      </div>
      ${count > 0 ? '<div class="gr-arrow">›</div>' : ''}
    </div>`;
  });

  el.innerHTML = html;
}

// ─── GROUP DETAIL ─────────────────────────────────────────────────
function autoPromoteScheduled() {
  const today = new Date(); today.setHours(0,0,0,0);
  let promoted = 0;
  tasks.forEach(t => {
    if (t.urgency === 'scheduled' && t.scheduledDate) {
      const d = new Date(t.scheduledDate + 'T00:00:00');
      if (d <= today) { t.urgency = 'must'; promoted++; }
    }
  });
  if (promoted) { save(); if (promoted > 0) toast(`${promoted}件のタスクを「今日中に絶対」に移動しました`); }
}
function showGroup(urgency) {
  currentUrgency = urgency;
  reorderMode = false;
  reorderTapSeq = [];
  const cfg = GROUP_CONFIG.find(g => g.urgency === urgency);
  const list = tasks.filter(t => !t.done && t.urgency === urgency);

  const estMin = list.reduce((s, t) => s + taskEstimate(t), 0);
  const estStr = estMin >= 60 ? (estMin / 60).toFixed(1) + 'h' : estMin + '分';

  document.getElementById('groupHeaderTitle').textContent = cfg.title;
  document.getElementById('groupHeaderSub').textContent   = list.length > 0 ? estStr : '';
  const reorderBtn = document.getElementById('groupReorderBtn');
  if (reorderBtn) {
    reorderBtn.classList.toggle('hidden', urgency !== 'must');
    reorderBtn.textContent = '編集';
    reorderBtn.classList.remove('active');
  }

  renderGroupList();
  document.getElementById('ffx-screen-group').classList.add('visible');
}

function renderGroupList() {
  let undone = tasks.filter(t => !t.done && t.urgency === currentUrgency);
  const done = tasks.filter(t =>  t.done && t.urgency === currentUrgency);
  if (currentUrgency === 'scheduled') {
    undone = undone.sort((a, b) => (a.scheduledDate || '') < (b.scheduledDate || '') ? -1 : 1);
  } else {
    undone = undone.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  const el = document.getElementById('groupTaskList');
  if (!undone.length && !done.length) {
    el.innerHTML = `<div class="empty-state"><p>タスクがありません</p></div>`;
    return;
  }
  // 今日中(must)は手番の番号を表示。「編集」中はタップした順に番号を振り直せる
  const showOrder = currentUrgency === 'must';
  const undoneHTML = undone.map(t => taskCardHTML(t, showOrder));
  const doneHTML = done.map(t => taskCardHTML(t, false));
  el.innerHTML = [...undoneHTML, ...doneHTML].join('');
  addSwipeListeners();
}

/** 「編集」⇔「完了」を切り替える。完了時にタップ順を確定して保存する */
function toggleReorderMode() {
  if (reorderMode) {
    finalizeReorder();
  } else {
    reorderMode = true;
    reorderTapSeq = [];
  }
  const btn = document.getElementById('groupReorderBtn');
  if (btn) {
    btn.textContent = reorderMode ? '完了' : '編集';
    btn.classList.toggle('active', reorderMode);
  }
  renderGroupList();
}

/** 編集モード中にタスクをタップ: 次の番号を振る (既にタップ済みなら末尾に振り直し) */
function reorderTap(id) {
  if (!reorderMode) return;
  reorderTapSeq = reorderTapSeq.filter(x => x !== id);
  reorderTapSeq.push(id);
  renderGroupList();
}

/** タップした順に order を確定。タップされなかったタスクは元の相対順のまま後ろに続く */
function finalizeReorder() {
  reorderMode = false;
  if (!reorderTapSeq.length) return;
  const group = tasks.filter(t => !t.done && t.urgency === currentUrgency)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const tapped   = reorderTapSeq.map(id => group.find(t => t.id === id)).filter(Boolean);
  const untapped = group.filter(t => !reorderTapSeq.includes(t.id));
  [...tapped, ...untapped].forEach((t, i) => { t.order = i; });
  reorderTapSeq = [];
  save();
}

function formatScheduledDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['日','月','火','水','木','金','土'];
  return `${d.getMonth()+1}/${d.getDate()}（${days[d.getDay()]}）に実行予定`;
}

/** showOrder: 今日中(must)グループの未完了タスクに手番の番号を出すか */
function taskCardHTML(t, showOrder) {
  const doneClass = t.done ? ' done-card' : '';
  const inEditMode = showOrder && reorderMode && !t.done;
  const bodyClick = inEditMode ? `onclick="FFX.reorderTap('${t.id}')"`
    : (t.done ? '' : `onclick="FFX.selectTask('${t.id}')"`);
  const scheduledStr = (t.urgency === 'scheduled' && t.scheduledDate)
    ? `<div style="font-size:12px;color:var(--text2);margin-top:2px;">${formatScheduledDate(t.scheduledDate)}</div>`
    : '';
  let orderBadge = '';
  if (showOrder && !t.done) {
    if (!reorderMode) {
      const group = tasks.filter(x => !x.done && x.urgency === currentUrgency)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      const n = group.findIndex(x => x.id === t.id) + 1;
      orderBadge = `<div class="task-card-order">${circledNumber(n)}</div>`;
    } else {
      const tapIdx = reorderTapSeq.indexOf(t.id);
      orderBadge = tapIdx >= 0
        ? `<div class="task-card-order">${circledNumber(tapIdx + 1)}</div>`
        : `<div class="task-card-order task-card-order-pending">○</div>`;
    }
  }
  const tappedClass = inEditMode && reorderTapSeq.includes(t.id) ? ' reorder-tapped' : '';
  return `<div class="swipe-container" data-id="${t.id}">
    <div class="delete-bg">削除</div>
    <div class="ffx-task-card${doneClass}${tappedClass}" data-urgency="${t.urgency || 'want'}">
      ${orderBadge}
      <div class="task-card-body" ${bodyClick} style="flex:1;min-width:0;cursor:${t.done ? 'default' : 'pointer'};">
        <div class="task-card-title">${esc(t.title)}</div>
        ${scheduledStr}
        <div class="task-card-meta">${taskEstimate(t)}分</div>
      </div>
      <button class="check-btn" onclick="FFX.toggleDone('${t.id}')" ${inEditMode ? 'disabled' : ''}>${t.done ? '✓' : ''}</button>
    </div>
  </div>`;
}

function addSwipeListeners() {
  document.querySelectorAll('#groupTaskList .swipe-container').forEach(container => {
    const card = container.querySelector('.ffx-task-card');
    let startX = 0, currentX = 0;

    container.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      currentX = startX;
      card.style.transition = 'none';
    }, { passive: true });

    container.addEventListener('touchmove', e => {
      currentX = e.touches[0].clientX;
      const dx = Math.min(0, currentX - startX);
      card.style.transform = `translateX(${Math.max(dx, -100)}px)`;
    }, { passive: true });

    container.addEventListener('touchend', () => {
      const dx = currentX - startX;
      if (dx < -72) {
        card.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        card.style.transform = 'translateX(-100%)';
        card.style.opacity = '0';
        const id = container.dataset.id;
        setTimeout(() => deleteTask(id), 210);
      } else {
        card.style.transition = 'transform 0.3s ease';
        card.style.transform = 'translateX(0)';
      }
    });
  });
}

// ─── TASK ACTIONS ─────────────────────────────────────────────────
function selectTask(id) {
  startFocus(id);
}

function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  save();
  renderMain();
  if (currentUrgency) renderGroupList();
}

function toggleDone(id) {
  const t = tasks.find(t => t.id === id);
  if (!t) return;
  t.done = !t.done;
  save();
  renderMain();
  if (currentUrgency) renderGroupList();
}

function addTask(t) {
  // 新規タスクは常に一覧の先頭に来るよう、既存の最小 order より小さい値を割り当てる
  const minOrder = tasks.length ? Math.min(...tasks.map(x => x.order || 0)) : 0;
  tasks.unshift({ id: uid(), done: false, steps: [], createdAt: new Date().toISOString(), order: minOrder - 1, ...t });
  save();
}

// ─── FOCUS MODE ───────────────────────────────────────────────────
function startFocus(id) {
  const t = tasks.find(t => t.id === id);
  if (!t) return;
  focusId = id;
  stopTimer();

  document.getElementById('timerHint').textContent = 'タップで開始';
  document.getElementById('focusTaskTitle').textContent = t.title;

  // スモールステップ描画（1件ずつ）
  renderCurrentStep();

  // 最初の未完了ステップの estimatedMinutes をタイマーにセット、なければタスク全体の見積もり
  const firstStep = (t.steps || []).find(s => !s.done);
  const mins = (firstStep && stepMinutes(firstStep) > 0) ? stepMinutes(firstStep) : taskEstimate(t);
  timerTotal = mins * 60;
  timerLeft  = timerTotal;
  updateTimerUI();
  document.getElementById('ffx-screen-focus').classList.add('visible');
}

function renderCurrentStep() {
  const widget = document.getElementById('focusStepWidget');
  const t = tasks.find(t => t.id === focusId);
  if (!t || !t.steps || t.steps.length === 0) {
    widget.style.display = 'none';
    return;
  }
  const steps = t.steps;
  const total = steps.length;
  // 最初の未完了ステップを探す
  const idx = steps.findIndex(s => !s.done);
  widget.style.display = 'block';

  if (idx === -1) {
    // 全ステップ完了
    widget.innerHTML = `<div class="focus-step-done-msg">✓ すべてのステップ完了</div>`;
    return;
  }
  const step = steps[idx];
  const label = stepLabel(step);
  const mins  = stepMinutes(step);
  const doneCount = steps.filter(s => s.done).length;
  const metaStr = mins > 0 ? `<div style="font-size:12px;color:var(--text3);margin-bottom:10px;">${mins}分</div>` : '';
  const btn = timerRunning
    ? `<button class="focus-step-next" onclick="FFX.advanceStep()">完了</button>`
    : `<button class="focus-step-start" onclick="FFX.startStep()">スタート</button>`;
  widget.innerHTML = `
    <div class="focus-step-counter" onclick="FFX.showStepList()" style="cursor:pointer">
      ステップ ${doneCount + 1} / ${total} &#8250;
    </div>
    <div class="focus-step-text">${esc(label)}</div>
    ${metaStr}
    ${btn}`;
}

function showStepList() {
  const t = tasks.find(t => t.id === focusId);
  if (!t || !t.steps) return;

  const items = t.steps.map((s, i) => {
    const done   = typeof s === 'object' ? (s.done || false) : false;
    const label  = stepLabel(s);
    const mins   = stepMinutes(s);
    const minsStr = mins > 0 ? `<span style="font-size:12px;color:var(--text3);margin-left:6px;">${mins}分</span>` : '';
    return `<div class="swipe-container" data-step-idx="${i}" style="margin-bottom:0;border-radius:0;overflow:hidden;">
      <div class="delete-bg" style="border-radius:0;">削除</div>
      <div class="step-list-item${done ? ' done' : ''}" style="cursor:pointer;padding:12px 4px 12px 0;"
        onclick="document.querySelector('.step-list-overlay').remove();FFX.openStepDetailFrom('${t.id}',${i})">
        <div class="step-list-check">${done ? '✓' : ''}</div>
        <div class="step-list-label" style="flex:1;">${esc(label)}${minsStr}</div>
        <div style="font-size:18px;color:var(--text3);padding-left:8px;">›</div>
      </div>
    </div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'step-list-overlay';
  overlay.innerHTML = `<div class="step-list-sheet">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div class="step-list-title" style="margin-bottom:0;">すべてのステップ</div>
      <button onclick="document.querySelector('.step-list-overlay').remove();FFX.openEditScreen('${t.id}')"
        style="border:none;background:none;font-family:'Noto Sans JP',sans-serif;font-size:14px;font-weight:700;color:var(--text);cursor:pointer;padding:4px 8px;">＋追加</button>
    </div>
    ${items}
  </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  // スワイプ削除リスナー
  overlay.querySelectorAll('.swipe-container').forEach(container => {
    const card = container.querySelector('.step-list-item');
    let startX = 0, startY = 0, curX = 0, swiping = false;
    container.addEventListener('touchstart', e => {
      startX = curX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = false;
      card.style.transition = 'none';
    }, { passive: true });
    container.addEventListener('touchmove', e => {
      curX = e.touches[0].clientX;
      const dx = curX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx < -10 && Math.abs(dx) > dy) {
        swiping = true;
        card.style.transform = `translateX(${Math.max(dx, -100)}px)`;
      }
    }, { passive: true });
    container.addEventListener('touchend', () => {
      const dx = curX - startX;
      if (swiping && dx < -70) {
        card.style.transition = 'transform .2s ease, opacity .2s ease';
        card.style.transform = 'translateX(-100%)';
        card.style.opacity = '0';
        const idx = parseInt(container.dataset.stepIdx);
        setTimeout(() => {
          const task = tasks.find(t => t.id === focusId);
          if (task) { task.steps.splice(idx, 1); save(); }
          overlay.remove();
          showStepList();
        }, 210);
      } else {
        card.style.transition = 'transform .3s ease';
        card.style.transform = 'translateX(0)';
      }
    });
  });
}

function startStep() {
  if (!timerRunning) toggleTimer(); // タイマースタート
  renderCurrentStep();              // ボタンを「完了」に切り替え
}

function advanceStep() {
  stopTimer();
  const t = tasks.find(t => t.id === focusId);
  if (!t || !t.steps) return;
  const idx = t.steps.findIndex(s => !s.done);
  if (idx === -1) return;
  t.steps[idx].done = true;
  save();
  // 全ステップ完了なら自動でタスク完了
  if (t.steps.every(s => s.done)) {
    renderCurrentStep();
    setTimeout(() => completeTask(), 800);
  } else {
    // 次のステップの estimatedMinutes をタイマーにセット
    const nextStep = t.steps.find(s => !s.done);
    const mins = (nextStep && stepMinutes(nextStep) > 0) ? stepMinutes(nextStep) : taskEstimate(t);
    timerTotal = mins * 60;
    timerLeft  = timerTotal;
    updateTimerUI();
    renderCurrentStep(); // 次のステップを「スタート」ボタンで表示
  }
}

function completeTask() {
  if (focusId) {
    const t = tasks.find(t => t.id === focusId);
    if (t) {
      t.done = true; save(); toast('✓ タスク完了！');
    }
  }
  stopTimer();
  document.getElementById('ffx-screen-focus').classList.remove('visible');
  document.getElementById('ffx-screen-group').classList.remove('visible');
  focusId = null;
  currentUrgency = null;
  renderMain();
}

function goBack(from) {
  if (from === 'focus') {
    stopTimer();
    document.getElementById('ffx-screen-focus').classList.remove('visible');
    focusId = null;
  } else if (from === 'group') {
    if (reorderMode) finalizeReorder(); // 編集中に戻った場合もタップ済み分は確定
    document.getElementById('ffx-screen-group').classList.remove('visible');
    currentUrgency = null;
    renderMain();
  }
}

// ─── TIMER ────────────────────────────────────────────────────────
function stopTimer() {
  clearInterval(timerTick);
  timerRunning = false;
}

function toggleTimer() {
  const hint = document.getElementById('timerHint');
  if (timerRunning) {
    stopTimer();
    hint.textContent = 'タップで再開';
  } else {
    if (timerLeft <= 0) timerLeft = timerTotal;
    timerRunning = true;
    hint.textContent = 'タップで一時停止';
    timerTick = setInterval(() => {
      timerLeft--;
      updateTimerUI();
      if (timerLeft <= 0) {
        stopTimer();
        hint.textContent = 'タップで開始';
        toast('⏰ 時間になりました！');
      }
    }, 1000);
  }
}

function updateTimerUI() {
  const m   = Math.floor(timerLeft / 60), s = timerLeft % 60;
  const pct = timerTotal > 0 ? (timerLeft / timerTotal * 100) : 0;
  const urgent = timerLeft <= 60 && timerLeft > 0;
  const color  = urgent ? 'var(--danger)' : '#e8553a';
  const track  = '#e8e4de';

  const el = document.getElementById('timerDisplay');
  el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  el.className   = 'timer-display' + (urgent ? ' urgent' : '');

  // 経過分をgray、残り分をredにすることでドットが時計回りに動く
  const elapsed = 100 - pct;
  document.getElementById('timerRing').style.background =
    `conic-gradient(${track} ${elapsed}%, ${color} ${elapsed}%)`;

  const dot = document.getElementById('timerDot');
  if (dot) {
    dot.setAttribute('transform', `rotate(${elapsed * 3.6},90,90)`);
    dot.style.opacity = pct > 1 ? '1' : '0';
  }
}

// ─── TABS ─────────────────────────────────────────────────────────
let currentTab = 'home';

function switchTab(tab) {
  if (deleteMode) toggleDeleteMode();
  currentTab = tab;
  document.getElementById('ffx-tab-home').classList.toggle('visible', tab === 'home');
  document.getElementById('tab-all').classList.toggle('visible', tab === 'all');
  const fcPanel = document.getElementById('ffx-tab-fc');
  if (fcPanel) fcPanel.classList.toggle('visible', tab === 'fc');
  document.getElementById('tab-btn-home').classList.toggle('active', tab === 'home');
  document.getElementById('tab-btn-all').classList.toggle('active', tab === 'all');
  const fcBtn = document.getElementById('tab-btn-fc');
  if (fcBtn) fcBtn.classList.toggle('active', tab === 'fc');
  // そうじでは＋追加ボタンを隠す (タスク管理用なので)
  const addBtn = document.getElementById('ffx-add-btn');
  if (addBtn) addBtn.style.display = (tab === 'fc') ? 'none' : '';
  if (tab === 'all') renderAllTasks();
  if (tab === 'fc' && window.FC) FC.render();
}

// ─── ALL TASKS VIEW ───────────────────────────────────────────────
const URGENCY_LABELS = { must: '今日中に絶対', want: 'できたらやりたい', nice: '余力があれば', scheduled: '後日実行予定' };

function formatDueDate(dateStr) {
  if (!dateStr) return null;
  const due = new Date(dateStr);
  if (isNaN(due)) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay - today) / 86400000);
  const days = ['日','月','火','水','木','金','土'];
  const label = `${due.getMonth()+1}/${due.getDate()}（${days[due.getDay()]}）`;
  if (diffDays < 0) return { label: `${label} 期限切れ`, cls: 'overdue' };
  if (diffDays === 0) return { label: `今日まで`, cls: 'overdue' };
  if (diffDays === 1) return { label: `明日まで`, cls: 'normal' };
  return { label: `${label}まで`, cls: 'normal' };
}

function renderTimeline() {
  const container = document.getElementById('timelineContainer');
  const withDue = tasks.filter(t => !t.done && t.dueDate);
  if (!withDue.length) { container.style.display = 'none'; return; }
  container.style.display = 'block';

  const today = new Date(); today.setHours(0,0,0,0);
  const groups = {};
  withDue.forEach(t => {
    const d = new Date(t.dueDate); d.setHours(0,0,0,0);
    const days = Math.round((d - today) / 86400000);
    if (!groups[t.dueDate]) groups[t.dueDate] = { days, count: 0, hasMust: false };
    groups[t.dueDate].count++;
    if (t.urgency === 'must') groups[t.dueDate].hasMust = true;
  });

  const dayVals = Object.values(groups).map(g => g.days);
  const minDay = Math.min(0, ...dayVals);
  const maxDay = Math.max(14, ...dayVals) + 2;
  const range  = maxDay - minDay;

  const W = 320, padL = 24, padR = 24, lineW = W - padL - padR;
  const lineY = 44;
  const H = 90;
  const xOf = d => padL + ((d - minDay) / range) * lineW;
  const todayX = xOf(0);

  // x座標順にソートしてラベル重なりを防ぐ
  const sorted = Object.entries(groups).sort((a, b) => a[1].days - b[1].days);
  const MIN_SPACING = 46;
  let lastLabelX = todayX; // 「今日」ラベルの位置を起点に

  const markers = sorted.map(([, g]) => {
    const x = xOf(g.days);
    const isOverdue = g.days < 0;
    const color = (isOverdue || g.hasMust) ? '#e74c3c' : '#aaa';
    const r = Math.max(9, Math.min(16, 9 + g.count - 1));
    const daysLabel = isOverdue ? `期限切れ`
      : g.days === 1 ? `明日`
      : `${g.days}日`;
    const canShowLabel = g.days !== 0 && Math.abs(x - lastLabelX) >= MIN_SPACING;
    if (canShowLabel) lastLabelX = x;
    return `
      <circle cx="${x}" cy="${lineY}" r="${r}" fill="${color}"/>
      <text x="${x}" y="${lineY}" text-anchor="middle" dominant-baseline="middle"
        font-size="${r >= 12 ? 12 : 10}" fill="white" font-weight="700">${g.count}</text>
      ${canShowLabel ? `<text x="${x}" y="${lineY + r + 14}" text-anchor="middle" font-size="13" fill="${color}" font-weight="500">${daysLabel}</text>` : ''}`;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="overflow:visible;display:block;">
      <line x1="${padL}" y1="${lineY}" x2="${W-padR}" y2="${lineY}" stroke="var(--border-strong)" stroke-width="2"/>
      <circle cx="${todayX}" cy="${lineY}" r="5" fill="var(--text)"/>
      <text x="${todayX}" y="${lineY + 19}" text-anchor="middle" font-size="13" fill="var(--text2)" font-weight="500">今日</text>
      ${markers}
    </svg>`;
}

function renderAllTasks() {
  renderTimeline();
  const el = document.getElementById('allTasksScroll');
  const html = ['must','want','nice','scheduled'].map(urgency => {
    const list = tasks.filter(t => !t.done && t.urgency === urgency);
    const cards = list.length
      ? list.map(t => {
          const due = formatDueDate(t.dueDate);
          const dueBadge = due
            ? `<div class="due-badge ${due.cls}">${due.label}</div>`
            : '';
          const scheduledBadge = (urgency === 'scheduled' && t.scheduledDate)
            ? `<div style="font-size:13px;color:var(--text2);margin-top:2px;">${formatScheduledDate(t.scheduledDate)}</div>`
            : '';
        return `<div class="all-task-card" data-id="${t.id}" data-urgency="${urgency}" onclick="FFX.allCardClick('${t.id}')">
            <div style="flex:1;min-width:0;">
              <div style="font-size:16px;font-weight:500;color:var(--text);line-height:1.4;word-break:break-word;">${esc(t.title)}</div>
              ${dueBadge}
              ${scheduledBadge}
              <div style="font-size:12px;color:var(--text3);margin-top:2px;">${taskEstimate(t)}分</div>
            </div>
            <div class="drag-handle" onclick="event.stopPropagation();FFX.openActionSheet('${t.id}')">⠿</div>
          </div>`;
        }).join('')
      : `<div style="padding:10px 0 4px;color:var(--text3);font-size:13px;">タスクなし</div>`;
    return `<div class="urgency-section ${urgency}-section" data-urgency="${urgency}">
      <div class="urgency-section-header">${URGENCY_LABELS[urgency]}</div>
      <div class="section-cards" data-urgency="${urgency}">${cards}</div>
    </div>`;
  }).join('');
  el.innerHTML = `<div style="padding-bottom:40px;">${html}</div>`;
  addDragListeners();
}

// ─── DELETE MODE ──────────────────────────────────────────────────
let deleteMode = false;

function toggleDeleteMode() {
  deleteMode = !deleteMode;
  const btn = document.getElementById('deleteModeBtn');
  const scroll = document.getElementById('allTasksScroll');
  btn.style.color      = deleteMode ? '#fff' : 'var(--text3)';
  btn.style.background = deleteMode ? '#e74c3c' : 'none';
  btn.style.borderColor= deleteMode ? '#e74c3c' : 'var(--border-strong)';
  scroll.classList.toggle('delete-mode-active', deleteMode);
  if (deleteMode) {
    addDeleteSwipeListeners();
    toast('右スワイプでタスクを削除');
  } else {
    toast('削除モードを終了');
  }
}

function addDeleteSwipeListeners() {
  document.querySelectorAll('#allTasksScroll .all-task-card').forEach(card => {
    if (card.dataset.swipeListened) return;
    card.dataset.swipeListened = '1';
    let startX = 0, startY = 0, curX = 0, swiping = false;

    card.addEventListener('touchstart', e => {
      if (!deleteMode) return;
      startX = curX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = false;
      card.style.transition = 'none';
    }, { passive: true });

    card.addEventListener('touchmove', e => {
      if (!deleteMode) return;
      curX = e.touches[0].clientX;
      const dx = curX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > 8 && dx > dy) {
        swiping = true;
        card.style.transform = `translateX(${Math.min(dx, 120)}px)`;
      }
    }, { passive: true });

    card.addEventListener('touchend', () => {
      if (!deleteMode) return;
      const dx = curX - startX;
      if (swiping && dx > 72) {
        document.addEventListener('click', e => e.stopPropagation(), { capture: true, once: true });
        card.style.transition = 'transform .2s ease, opacity .2s ease';
        card.style.transform = 'translateX(110%)';
        card.style.opacity = '0';
        setTimeout(() => deleteTask(card.dataset.id), 210);
      } else {
        card.style.transition = 'transform .3s ease';
        card.style.transform = 'translateX(0)';
      }
    });
  });
}

// ─── ACTION SHEET ─────────────────────────────────────────────────
function getTargetUrgency(touchY) {
  const want = document.querySelector('#allTasksScroll .want-section');
  const nice = document.querySelector('#allTasksScroll .nice-section');
  if (!want || !nice) return null;
  const wantTop = want.getBoundingClientRect().top;
  const niceTop = nice.getBoundingClientRect().top;
  if (touchY < wantTop) return 'must';
  if (touchY >= niceTop) return 'nice';
  return 'want';
}

function addDragListeners() {} // ドラッグ廃止・⠿タップでアクションシートを開く

let actionTaskId = null;

function openActionSheet(id) {
  actionTaskId = id;
  const t = tasks.find(t => t.id === id);
  if (!t) return;
  document.getElementById('actionTitle').textContent = t.title;
  ['must','want','nice','scheduled'].forEach(u => {
    const btn = document.getElementById('aub-' + u);
    if (btn) btn.className = 'action-urgency-btn' + (t.urgency === u ? ' cur-' + u : '');
  });
  document.getElementById('actionOverlay').classList.add('open');
}

function closeActionSheet() {
  document.getElementById('actionOverlay').classList.remove('open');
  actionTaskId = null;
}

function actionEdit() {
  const id = actionTaskId;
  closeActionSheet();
  openEditScreen(id);
}

function actionDelete() {
  const id = actionTaskId;
  closeActionSheet();
  deleteTask(id);
}

function actionSetUrgency(urgency) {
  const t = tasks.find(t => t.id === actionTaskId);
  if (!t) return;
  t.urgency = urgency;
  save(); renderMain(); renderAllTasks();
  closeActionSheet();
  toast('優先度を変更しました');
}

// ─── 期限切れタスクの棚卸し (triage.js から呼ばれる) ────────────────
/** 未完了・期限切れ(dueDate が今日より前)のタスク一覧 */
function overdueTasks() {
  const today = todayStr();
  return tasks.filter(t => !t.done && t.dueDate && t.dueDate < today);
}

function triageTaskToday(id) {
  const t = tasks.find(t => t.id === id);
  if (!t) return;
  t.urgency = 'must';
  // 期限も今日にする。これで今日はもう「期限切れ」ではなくなり、
  // 終わらなければ翌日また期限切れとして棚卸しに出てくる
  t.dueDate = todayStr();
  save(); renderMain(); renderAllTasks();
}

function triageDeferTask(id, newDate) {
  const t = tasks.find(t => t.id === id);
  if (!t) return;
  t.dueDate = newDate;
  save(); renderMain(); renderAllTasks();
}

function triageDeleteTask(id) {
  deleteTask(id);
  renderAllTasks();
}

// ─── EDIT SCREEN ─────────────────────────────────────────────────
let editId = null;

function openEditScreen(id) {
  editId = id;
  const t = tasks.find(t => t.id === id);
  if (!t) return;
  document.getElementById('editTaskTitle').value = t.title || '';
  document.getElementById('editDueDate').value = t.dueDate || '';
  document.getElementById('editScheduledDate').value = t.scheduledDate || '';
  renderEditSteps(t.steps || []);
  document.getElementById('ffx-screen-edit').classList.add('visible');
}

function closeEditScreen() {
  // タイトル未入力・ステップなしの空タスク (新規作成の取りやめ等) は捨てる
  const t = tasks.find(t => t.id === editId);
  if (t && !(t.title || '').trim() && !(t.steps || []).some(s => stepLabel(s))) {
    tasks = tasks.filter(x => x.id !== editId);
    save();
    renderMain();
    if (currentTab === 'all') renderAllTasks();
  }
  document.getElementById('ffx-screen-edit').classList.remove('visible');
  editId = null;
}

// ＋ボタンからの新規タスク作成 (編集画面を新規タスクで開く)
function openNewTask() {
  const t = { id: uid(), title: '', urgency: 'want', done: false, steps: [],
              estimate: 30, createdAt: new Date().toISOString() };
  tasks.unshift(t);
  openEditScreen(t.id);
}

// 「すべて」タブのカードタップ (削除モード中は編集を開かない)
function allCardClick(id) {
  if (!deleteMode) openEditScreen(id);
}

function renderEditSteps(steps) {
  const el = document.getElementById('stepEditList');
  if (!steps.length) {
    el.innerHTML = `<div style="color:var(--text3);font-size:14px;padding:8px 0;">ステップがありません</div>`;
    return;
  }
  el.innerHTML = steps.map((s, i) => {
    const text = stepLabel(s) || '（未入力）';
    const mins = stepMinutes(s);
    return `<div class="swipe-container" data-step-idx="${i}">
      <div class="delete-bg">削除</div>
      <div class="step-list-card" onclick="FFX.openStepDetail(${i})">
        <div class="step-list-card-text">${esc(text)}</div>
        ${mins ? `<div class="step-list-card-meta">${mins}分</div>` : ''}
        <div class="step-list-card-arrow">›</div>
      </div>
    </div>`;
  }).join('');
  addStepSwipeListeners();
}

function addStepSwipeListeners() {
  document.querySelectorAll('#stepEditList .swipe-container').forEach(container => {
    const card = container.querySelector('.step-list-card');
    let startX = 0, startY = 0, curX = 0, swiping = false;
    container.addEventListener('touchstart', e => {
      startX = curX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = false;
      card.style.transition = 'none';
    }, { passive: true });
    container.addEventListener('touchmove', e => {
      curX = e.touches[0].clientX;
      const dx = curX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx < -10 && Math.abs(dx) > dy) {
        swiping = true;
        card.style.transform = `translateX(${Math.max(dx, -100)}px)`;
      }
    }, { passive: true });
    container.addEventListener('touchend', () => {
      const dx = curX - startX;
      if (swiping && dx < -70) {
        card.style.transition = 'transform .2s ease, opacity .2s ease';
        card.style.transform = 'translateX(-100%)';
        card.style.opacity = '0';
        const idx = parseInt(container.dataset.stepIdx);
        setTimeout(() => deleteEditStep(idx), 210);
      } else {
        card.style.transition = 'transform .3s ease';
        card.style.transform = 'translateX(0)';
      }
    });
  });
}

function addEditStep() {
  const t = tasks.find(t => t.id === editId);
  if (!t) return;
  t.steps.push({ text: '', done: false, estimatedMinutes: 0 });
  save();
  renderEditSteps(t.steps);
  openStepDetail(t.steps.length - 1);
}

// ─── STEP DETAIL EDIT ────────────────────────────────────────────
let editStepIdx = null;
let stepDetailFromSheet = false;

function openStepDetailFrom(taskId, idx) {
  stepDetailFromSheet = true;
  editId = taskId;
  const t = tasks.find(t => t.id === taskId);
  if (t) renderEditSteps(t.steps || []);
  openStepDetail(idx);
}

function openStepDetail(idx) {
  const t = tasks.find(t => t.id === editId);
  if (!t) return;
  editStepIdx = idx;
  const s = t.steps[idx];
  document.getElementById('stepDetailText').value = stepLabel(s) || '';
  document.getElementById('stepDetailMins').value = stepMinutes(s) || '';
  document.getElementById('ffx-screen-step-edit').classList.add('visible');
  setTimeout(() => document.getElementById('stepDetailText').focus(), 100);
}

function closeStepDetail() {
  document.getElementById('ffx-screen-step-edit').classList.remove('visible');
  editStepIdx = null;
  if (stepDetailFromSheet) {
    stepDetailFromSheet = false;
    showStepList();
  }
}

function saveStepDetail() {
  const t = tasks.find(t => t.id === editId);
  if (!t || editStepIdx === null) return;
  const text = document.getElementById('stepDetailText').value.trim();
  const mins = parseInt(document.getElementById('stepDetailMins').value) || 0;
  const existing = t.steps[editStepIdx];
  t.steps[editStepIdx] = { text, done: existing ? existing.done : false, estimatedMinutes: mins };
  if (!text) t.steps.splice(editStepIdx, 1); // 空なら削除
  t.estimate = t.steps.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0) || t.estimate;
  save();
  renderEditSteps(t.steps);
  closeStepDetail();
  toast('✓ 保存しました');
}

function deleteFromStepDetail() {
  const t = tasks.find(t => t.id === editId);
  if (!t || editStepIdx === null) return;
  t.steps.splice(editStepIdx, 1);
  save();
  renderEditSteps(t.steps);
  closeStepDetail();
}

function deleteEditStep(idx) {
  const t = tasks.find(t => t.id === editId);
  if (!t) return;
  t.steps.splice(idx, 1);
  save();
  renderEditSteps(t.steps);
}

function saveEdit() {
  const t = tasks.find(t => t.id === editId);
  if (!t) return;
  const newTitle = document.getElementById('editTaskTitle').value.trim();
  if (newTitle) t.title = newTitle;
  const newDue = document.getElementById('editDueDate').value;
  if (newDue) t.dueDate = newDue; else delete t.dueDate;
  const newScheduled = document.getElementById('editScheduledDate').value;
  if (newScheduled) {
    t.scheduledDate = newScheduled;
    // 実行日が未来なら自動的に「後日実行予定」に
    const today = new Date(); today.setHours(0,0,0,0);
    const d = new Date(newScheduled + 'T00:00:00');
    if (d > today && t.urgency !== 'scheduled') t.urgency = 'scheduled';
  } else {
    delete t.scheduledDate;
    if (t.urgency === 'scheduled') t.urgency = 'want';
  }
  t.estimate = t.steps.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0) || t.estimate;
  save();
  renderMain();
  if (currentTab === 'all') renderAllTasks();
  closeEditScreen();
  toast('✓ 保存しました');
}


// iOSキーボード表示時にeditScrollをスクロール可能に保つ
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const editScroll = document.getElementById('editScroll');
    const editScreen = document.getElementById('ffx-screen-edit');
    if (editScroll && editScreen && editScreen.classList.contains('visible')) {
      editScroll.style.maxHeight = (window.visualViewport.height - 56) + 'px';
    }
  });
}

if ('serviceWorker' in navigator) {
  // 新しいSWがアクティブになったら自動リロード（キャッシュ更新を即反映）
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ─── INIT ─────────────────────────────────────────────────────────
save();
renderMain();

// クォート正規化（アプリ版Claude対策）
function normalizeQuotes(text) {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\uFF07]/g, "'")
    .trim();
}

// LINEボットから自動取り込む
let isImporting = false;
async function importFromLine() {
  if (isImporting) return;
  isImporting = true;
  try {
    const res = await fetch('https://divine-wildflower-8952.piinatsu123.workers.dev/tasks');
    const newTasks = await res.json();
    if (!newTasks || newTasks.length === 0) return;
    newTasks.forEach(t => {
      const steps = (t.steps || []).map(s => typeof s === 'string'
        ? { text: s, done: false, estimatedMinutes: 0 }
        : { text: s.text || s.title || '', done: s.done || false,
            estimatedMinutes: s.estimatedMinutes || 0 });
      const urgency = t.urgency || 'want';
      const fromSteps = steps.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
      const estimate = fromSteps > 0 ? fromSteps : (t.estimate || 30);
      const { id, ...rest } = t;
      addTask({ ...rest, urgency, estimate, steps, done: false });
    });
    await fetch('https://divine-wildflower-8952.piinatsu123.workers.dev/tasks', { method: 'DELETE' });
    renderMain();
    toast('✓ ' + newTasks.length + '件のタスクをLINEから取り込みました');
  } catch (e) {
    // サイレントに失敗
  } finally {
    isImporting = false;
  }
}

// アプリを開いたとき・フォアグラウンドに戻ったとき自動チェック
importFromLine();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') importFromLine();
});

// クリップボードからインポート（ボタン押下時）
async function importFromClipboard() {
  // 1. クリップボードを試みる
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { /* 権限なし → promptへ */ }

  // 2. クリップボードの内容がJSONでなければpromptにフォールバック
  let parsed;
  try {
    parsed = JSON.parse(normalizeQuotes(text));
  } catch {
    text = prompt('JSONを貼り付けてください：');
    if (!text) return;
    text = text.trim();
    try {
      parsed = JSON.parse(normalizeQuotes(text));
    } catch {
      alert('JSONとして読み込めませんでした。');
      return;
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    alert('インポートできるタスクがありませんでした。');
    return;
  }

  const urgMap = { must: 'must', want: 'want', idea: 'nice' };
  const priMap = { high: 'must', medium: 'want', low: 'nice' };
  parsed.forEach(t => {
    // steps を内部フォーマット（text/done/estimatedMinutes）に統一
    const steps = (t.steps || []).map(s => typeof s === 'string'
      ? { text: s, done: false, estimatedMinutes: 0 }
      : { text: s.text || s.title || '', done: s.done || false,
          estimatedMinutes: s.estimatedMinutes || 0 });
    const urgency = t.urgency || urgMap[t.type] || priMap[t.priority] || 'want';
    // stepsに見積もりがあればその合計、なければ t.estimate or 30
    const fromSteps = steps.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
    const estimate  = fromSteps > 0 ? fromSteps : (t.estimate || 30);
    addTask({ ...t, urgency, estimate, steps, done: false });
  });
  renderMain();
  toast('✓ ' + parsed.length + '件のタスクをインポートしました');
}

// ─── 公開 API ─────────────────────────────────────────────────────
window.FFX = {
  // inline onclick 用
  switchTab, showGroup, goBack, selectTask, toggleDone, toggleDeleteMode,
  toggleReorderMode, reorderTap,
  toggleTimer, startStep, advanceStep, completeTask, showStepList,
  openEditScreen, closeEditScreen, openNewTask, allCardClick,
  openStepDetail, openStepDetailFrom, closeStepDetail, saveStepDetail, deleteFromStepDetail,
  addEditStep, saveEdit,
  openActionSheet, closeActionSheet, actionEdit, actionDelete, actionSetUrgency,
  importFromClipboard, importFromLine,
  // app.js 連携用
  renderMain, addTask,
  getTasks: function () { return tasks; },
  getCurrentTab: function () { return currentTab; },
  // triage.js (期限切れタスクの棚卸し) 連携用
  getOverdueTasks: overdueTasks, triageTaskToday, triageDeferTask, triageDeleteTask
};
})();
