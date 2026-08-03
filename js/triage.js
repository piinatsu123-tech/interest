'use strict';
/* triage.js — 期限切れタスクの棚卸し(毎日最初のアクセス時)
   FocusFlow の期限切れタスク(dueDate が今日より前・未完了)が1件でもあれば、
   タスク画面に進む前にカード形式で1件ずつ「今日/明日・来週・日付指定で延期/
   削除/あとで」を選ばせる。ゼロ件の日は何もしない。
   公開: window.Triage.maybeStart(afterDone) / openManually() */
(function () {

let queue = [];   // トリアージ対象タスクの id 一覧 (今回のセッション分)
let idx = 0;
let onDone = null;

function overdueList() {
  return (window.FFX && FFX.getOverdueTasks) ? FFX.getOverdueTasks() : [];
}

function currentTask() {
  const id = queue[idx];
  const t = (window.FFX ? FFX.getTasks() : []).find(t => t.id === id);
  return t || null;
}

/** キューを先頭から検査し、既に処理済み(削除された/期限が動いた)分をスキップ */
function advanceToValid() {
  const today = todayStr();
  while (idx < queue.length) {
    const t = currentTask();
    if (t && !t.done && t.dueDate && t.dueDate < today) return;
    idx++;
  }
}

function formatOverdueDays(dueDate) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + 'T00:00:00');
  const diff = Math.round((today - due) / 86400000);
  return diff <= 0 ? '期限切れ' : `${diff}日前が期限`;
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function render() {
  advanceToValid();
  if (idx >= queue.length) { finish(); return; }
  const t = currentTask();
  document.getElementById('triage-progress').textContent = `${idx + 1} / ${queue.length}`;
  document.getElementById('triage-task-title').textContent = t.title;
  document.getElementById('triage-overdue-label').textContent = formatOverdueDays(t.dueDate);
  const dateInput = document.getElementById('triage-date-input');
  if (dateInput) {
    dateInput.min = todayStr();
    dateInput.value = '';
  }
}

function next() { idx++; render(); }

function actToday() {
  const t = currentTask(); if (!t) return;
  FFX.triageTaskToday(t.id);
  next();
}

function actDefer(days) {
  const t = currentTask(); if (!t) return;
  FFX.triageDeferTask(t.id, addDays(days));
  next();
}

function actDeferToDate(dateStr) {
  const t = currentTask(); if (!t || !dateStr) return;
  FFX.triageDeferTask(t.id, dateStr);
  next();
}

// タスクのスワイプ削除と同じく確認なしの即時削除 (棚卸しはワンタップ前提)
function actDelete() {
  const t = currentTask(); if (!t) return;
  FFX.triageDeleteTask(t.id);
  next();
}

function actSkip() { next(); }

function finish() {
  document.getElementById('triage-overlay').classList.add('hidden');
  const cb = onDone;
  onDone = null;
  queue = []; idx = 0;
  if (cb) cb();
}

/** 期限切れタスクがあれば棚卸し画面を挟んでから afterDone() を呼ぶ。
    無ければ即座に afterDone() を呼ぶ (画面は一切表示しない) */
function maybeStart(afterDone) {
  const list = overdueList();
  if (!list.length) { afterDone(); return; }
  queue = list.map(t => t.id);
  idx = 0;
  onDone = afterDone;
  document.getElementById('triage-overlay').classList.remove('hidden');
  render();
}

/** せってい画面などから手動で開く。自動起動と違い、期限切れが無ければ
    「無かった」ことが分かるようトーストを出す(自動起動は毎日無音のまま) */
function openManually() {
  if (!overdueList().length) {
    if (typeof showToast === 'function') showToast('期限切れのタスクはありません');
    return;
  }
  maybeStart(() => {});
}

function bindEvents() {
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  bind('triage-today', actToday);
  bind('triage-defer-1', () => actDefer(1));
  bind('triage-defer-7', () => actDefer(7));
  bind('triage-delete', actDelete);
  bind('triage-skip', actSkip);
  bind('settings-triage-btn', openManually);
  const dateInput = document.getElementById('triage-date-input');
  if (dateInput) dateInput.addEventListener('change', () => actDeferToDate(dateInput.value));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindEvents);
} else {
  bindEvents();
}

window.Triage = { maybeStart, openManually };
})();
