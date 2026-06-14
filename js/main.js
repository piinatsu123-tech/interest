'use strict';

/* main.js — タブ切替・イベント登録・起動 */

// ─── 画面切替 ────────────────────────────────────────────────
// メインは FocusFlow (#tab-tasks)。お部屋はその中の room タブ。
// プレゼント/おでかけ/きろく/せってい はお部屋ハブから開くサブ画面。
let currentTab = 'tasks';

function switchTab(tabName) {
  currentTab = tabName;

  // タブセクション (#tab-tasks / #tab-shop / #tab-date / #tab-records / #tab-settings)
  document.querySelectorAll('.tab-section').forEach(s => {
    s.classList.toggle('hidden', s.id !== `tab-${tabName}`);
  });

  refreshBottomNav();

  // 画面ごとの更新
  if (tabName === 'tasks') {
    if (window.FFX) FFX.renderMain();
  } else if (tabName === 'shop') {
    renderShop();
  } else if (tabName === 'date') {
    renderDateSpots();
  } else if (tabName === 'records') {
    renderRecords();
  } else if (tabName === 'settings') {
    initSettingsTab();
  }
}

/** お部屋 (いっしょぐらし) を開く: 開いている詳細画面を閉じ、room タブにする */
function openRoom() {
  // 集中モード・グループ詳細のオーバーレイを閉じてから
  ['ffx-screen-group', 'ffx-screen-focus'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('visible');
  });
  switchTab('tasks');
  if (window.FFX) FFX.switchTab('room');
}

/** お部屋タブが今表示されているか */
function isRoomVisible() {
  const tasks = document.getElementById('tab-tasks');
  const room = document.getElementById('ffx-tab-room');
  return !!(tasks && !tasks.classList.contains('hidden')
    && room && room.classList.contains('visible'));
}

/**
 * 下部ナビを現在の画面に合わせて更新する。
 * FocusFlow のタスク/すべて表示中は「お部屋」へ行く 1 タブだけ (`.compact`)、
 * お部屋・ゲーム各画面ではフルの 5 タブを出す。アクティブはお部屋を開いている時の「お部屋」、各サブ画面はその項目。
 */
function refreshBottomNav() {
  const bar = document.querySelector('.tab-bar');
  if (!bar) return;
  const ffxTab = (window.FFX && FFX.getCurrentTab) ? FFX.getCurrentTab() : 'home';
  const inTaskView = (currentTab === 'tasks') && (ffxTab !== 'room');
  bar.classList.toggle('compact', inTaskView);
  let navKey = null;
  if (currentTab === 'tasks') navKey = (ffxTab === 'room') ? 'room' : null;
  else navKey = currentTab;
  bar.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === navKey);
  });
}

/** お部屋タブに入ったときの描画と挨拶 (FFX.switchTab('room') から呼ばれる) */
function enterRoom() {
  refreshStatusBar();
  // 時間帯の背景 (背景は常に更新、挨拶はスロットが変わったときだけ)
  const slot = currentTimeSlot();
  const roomBg = document.getElementById('room-bg');
  if (roomBg) roomBg.className = `room-bg time-${slot.base}`;
  if (_lastGreetSlotId !== null && _lastGreetSlotId !== slot.id) {
    _lastGreetSlotId = slot.id;
    _homeRestExpr = getDefaultExpression();
    renderChara('home-chara', _homeRestExpr);
    showBubble(getSpeech(getGreetingSituation()));
  } else if (hasExpressionVariants()) {
    // 表情差分があるキャラは、お部屋に来るたび休憩中の顔を入れ替える (固定回避)
    _homeRestExpr = getDefaultExpression();
    renderChara('home-chara', _homeRestExpr);
  }
}

// ─── イベント登録 ────────────────────────────────────────────
function bindEvents() {
  // 下部タブバー: お部屋 / プレゼント / おでかけ / きろく / せってい
  document.querySelectorAll('.tab-bar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nav = btn.dataset.nav;
      if (nav === 'room') openRoom();
      else switchTab(nav);
    });
  });

  // お部屋：立ち絵クリック
  const homeChara = document.getElementById('home-chara');
  if (homeChara) {
    homeChara.addEventListener('click', () => {
      const speech = getSpeech('idle');
      _lastBubbleText = speech.text;
      showBubble(speech, homeIdleExpression());
    });
  }

  // デート VN: クリックで進む
  const vnUI = document.getElementById('vn-ui');
  if (vnUI) {
    vnUI.addEventListener('click', advanceVN);
  }

  // レベルアップ: OK ボタン
  const levelupOk = document.getElementById('levelup-ok');
  if (levelupOk) {
    levelupOk.addEventListener('click', () => {
      document.getElementById('levelup-overlay').classList.add('hidden');
    });
  }

  // せってい: 保存
  const settingsSave = document.getElementById('settings-save');
  if (settingsSave) settingsSave.addEventListener('click', saveSettings);

  // キャラインポート関連
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  bind('char-prompt-btn',   openCharPromptModal);
  bind('char-prompt-close', () => document.getElementById('char-prompt-modal').classList.add('hidden'));
  bind('char-prompt-copy',  copyCharPrompt);
  bind('char-import-btn',   () => openCharImportModal('settings'));
  bind('wizard-import-btn', () => openCharImportModal('setup'));
  bind('char-import-close', closeCharImportModal);
  bind('char-import-cancel', closeCharImportModal);
  bind('char-import-apply', applyCharImport);
  const importText = document.getElementById('char-import-text');
  if (importText) importText.addEventListener('input', refreshCharImportPreview);

  // 画像アップロード (せってい/ウィザード/表情差分 共用のファイル入力)
  const artInput = document.getElementById('art-file-input');
  if (artInput) artInput.addEventListener('change', () => {
    if (artInput.files && artInput.files[0]) handleArtFileSelected(artInput.files[0]);
  });
  bind('settings-art-upload-btn', () => openArtPicker('settings'));
  bind('wizard-art-upload-btn',   () => openArtPicker('setup'));
  bind('settings-art-revert-btn', () => revertCustomArt('settings'));
  bind('wizard-art-revert-btn',   () => revertCustomArt('setup'));

  // 時間帯エディタ
  bind('timeslot-add',   addTimeSlot);
  bind('timeslot-reset', resetTimeSlots);

  // 複数キャラ: 追加・ウィザード中止
  bind('roster-add-btn',    startAddCharacter);
  bind('wizard-cancel-btn', cancelAddCharacter);

  // デートシナリオエディタ
  bind('ded-back',     closeDateEditor);
  bind('ded-add-beat', () => dedAppendBeat('char', ''));
  bind('ded-save',     dedSave);
  bind('ded-preview',  dedPreview);
  bind('ded-delete',   dedDelete);

  // セリフエディタ
  bind('dialogue-editor-btn', openDialogueEditor);
  bind('de-back', () => {
    if (deCurrentSit !== null) deBackToList();
    else closeDialogueEditor();
  });
  bind('de-add',   deAddLine);
  bind('de-copy',  deCopyPreset);
  bind('de-try',   deTry);
  bind('de-save',  deSave);
  bind('de-reset', deResetSit);
  bind('de-prompt-btn', () => openPromptModal('dialogue'));
  bind('de-import-btn', () => openPartialImport('dialogue'));

  // 部分インポートモーダル
  bind('pi-close',  () => document.getElementById('partial-import-modal').classList.add('hidden'));
  bind('pi-cancel', () => document.getElementById('partial-import-modal').classList.add('hidden'));
  bind('pi-apply',  applyPartialImport);
  const piText = document.getElementById('pi-text');
  if (piText) piText.addEventListener('input', refreshPartialImport);
  const piModal = document.getElementById('partial-import-modal');
  if (piModal) piModal.addEventListener('click', e => {
    if (e.target === piModal) piModal.classList.add('hidden');
  });
  // モーダル外クリックで閉じる
  ['char-prompt-modal', 'char-import-modal'].forEach(id => {
    const overlay = document.getElementById(id);
    if (overlay) overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  // せってい: リセット
  const settingsReset = document.getElementById('settings-reset');
  if (settingsReset) settingsReset.addEventListener('click', showResetConfirm);

  // 確認ダイアログ: OK
  const confirmOk = document.getElementById('confirm-ok');
  if (confirmOk) {
    confirmOk.addEventListener('click', () => {
      document.getElementById('confirm-overlay').classList.add('hidden');
      const cb = _confirmCallback;
      _confirmCallback = null;
      if (cb) cb();
    });
  }

  // 確認ダイアログ: キャンセル
  const confirmCancel = document.getElementById('confirm-cancel');
  if (confirmCancel) {
    confirmCancel.addEventListener('click', () => {
      document.getElementById('confirm-overlay').classList.add('hidden');
    });
  }

  // セットアップ: ステップナビ
  bindSetupNavEvents();

  // ページ表示/非表示でロールオーバーチェック
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isSetupDone()) {
      const wasAway = doRollover();
      if (wasAway) {
        // 久しぶりはお部屋を開いて「おかえり」を見せる
        openRoom();
        renderHome(true);
      }
      // FocusFlow 側での完了を検知
      ffCheckExternalCompletions();
    }
  });

  // 別タブ (旧 FocusFlow 等) がタスクを更新したら報酬判定だけ行う
  window.addEventListener('storage', e => {
    if (e.key === FF_KEY && isSetupDone()) {
      ffCheckExternalCompletions();
    }
  });

}

function bindSetupNavEvents() {
  // Step1 → Step2
  const step1Next = document.getElementById('step1-next');
  if (step1Next) step1Next.addEventListener('click', () => goToStep(2));

  // Step2 → Step1
  const step2Back = document.getElementById('step2-back');
  if (step2Back) step2Back.addEventListener('click', () => goToStep(1));

  // Step2 → Step3
  const step2Next = document.getElementById('step2-next');
  if (step2Next) step2Next.addEventListener('click', () => goToStep(3));

  // Step3 → Step2
  const step3Back = document.getElementById('step3-back');
  if (step3Back) step3Back.addEventListener('click', () => goToStep(2));

  // Step3 完了
  const step3Finish = document.getElementById('step3-finish');
  if (step3Finish) step3Finish.addEventListener('click', finishSetup);
}

// ─── 起動処理 ────────────────────────────────────────────────
function init() {
  loadState();

  if (!isSetupDone()) {
    // セットアップウィザード
    document.getElementById('screen-setup').classList.remove('hidden');
    document.getElementById('screen-main').classList.add('hidden');
    initWizard();
  } else {
    // 日付ロールオーバー
    const wasAway = doRollover();

    document.getElementById('screen-setup').classList.add('hidden');
    document.getElementById('screen-main').classList.remove('hidden');

    // お部屋の状態を用意 (背景・立ち絵・休憩中の表情)
    prepareRoom();

    if (wasAway) {
      // 久しぶりはお部屋を開いて「おかえり」を見せる
      openRoom();
      renderHome(true);
    } else {
      // 通常起動は FocusFlow のタスクダッシュボードから
      switchTab('tasks');
      if (window.FFX) FFX.switchTab('home');
    }

    // 見切れているカスタム立ち絵を修復 (旧サニタイザーの viewBox 強制の救済)
    repairCustomArtViewBox();

    // 旧バージョンのネイティブタスクを FocusFlow システムへ一度だけ移行
    migrateNativeTasks();

    // 別の場所 (旧 FocusFlow・別タブ) での完了を検知して報酬付与
    // (comeback の挨拶を消さないよう少し遅らせる)
    setTimeout(ffCheckExternalCompletions, wasAway ? 2500 : 800);
  }

  bindEvents();
}

// 旧いっしょぐらしのネイティブタスク → ff-tasks への一回限りの移行
function migrateNativeTasks() {
  if (state.ff.migrated || !Array.isArray(state.tasks) || state.tasks.length === 0) {
    state.ff.migrated = true;
    return;
  }
  const map = { hard: 'must', normal: 'want', easy: 'nice' };
  if (window.FFX) {
    state.tasks.filter(t => !t.done).forEach(t => {
      FFX.addTask({ title: t.title, urgency: map[t.difficulty] || 'want', estimate: 30, steps: [], done: false });
    });
    FFX.renderMain();
  }
  state.tasks = [];
  state.ff.migrated = true;
  saveState();
}

// DOM 準備完了後に起動
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// グローバル公開
window.App = {
  state, saveState, switchTab, openRoom, isRoomVisible,
  // FFX (focusflow.js) の上部タブ切替時に呼ばれる
  enterRoom: enterRoom,
  refreshBottomNav: refreshBottomNav,
  // ユーザーがタスクを完了した瞬間に FFX が呼ぶ (完了後はお部屋へ自動移動)
  onUserCompletedTask: function () { _pendingRoomJump = true; },
  // FFX (focusflow.js) の save() から毎回呼ばれる
  onTasksChanged: function () { ffCheckExternalCompletions(); }
};
