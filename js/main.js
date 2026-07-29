'use strict';

/* main.js — 画面切替・イベント登録・起動
   画面は FocusFlow (#tab-tasks: タスク/すべて/そうじ) と せってい (#tab-settings) の 2 つ。
   せっていはヘッダーの ⚙ ボタンから開き、戻るボタンでタスクへ返る。 */

let currentTab = 'tasks';

function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.tab-section').forEach(s => {
    s.classList.toggle('hidden', s.id !== `tab-${tabName}`);
  });
  if (tabName === 'tasks' && window.FFX) FFX.renderMain();
}

function openSettings() {
  // 集中モード・グループ詳細・タスク編集のオーバーレイを閉じてから開く
  ['ffx-screen-group', 'ffx-screen-focus', 'ffx-screen-edit'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('visible');
  });
  switchTab('settings');
}

// ─── イベント登録 ────────────────────────────────────────────
function bindEvents() {
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

  // せってい: 開く / 戻る / リセット
  bind('open-settings-btn', openSettings);
  bind('settings-back-btn', () => switchTab('tasks'));
  bind('settings-reset', showResetConfirm);

  // 確認ダイアログ
  bind('confirm-ok', () => {
    document.getElementById('confirm-overlay').classList.add('hidden');
    const cb = _confirmCallback;
    _confirmCallback = null;
    if (cb) cb();
  });
  bind('confirm-cancel', () => {
    document.getElementById('confirm-overlay').classList.add('hidden');
  });

  // 日付が変わってからの復帰なら、期限切れタスクがある場合だけ棚卸しを挟む
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const { isNewDay } = doRollover();
    if (isNewDay && window.Triage) Triage.maybeStart(() => {});
  });
}

// ─── 起動処理 ────────────────────────────────────────────────
function init() {
  loadState();
  const { isNewDay } = doRollover();

  document.getElementById('screen-main').classList.remove('hidden');
  switchTab('tasks');
  if (window.FFX) FFX.switchTab('home');

  // 日付が変わっての最初のアクセスなら、期限切れタスクがある場合だけ棚卸しを挟む
  if (isNewDay && window.Triage) Triage.maybeStart(() => {});

  bindEvents();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// グローバル公開 (focusflow.js / flowclean.js / triage.js から参照)
window.App = { switchTab, openSettings };
