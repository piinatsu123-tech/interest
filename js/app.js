'use strict';

/* =========================================================
   いっしょぐらし — app.js
   状態管理・画面遷移・タスク・UI ロジック全部
   ========================================================= */

// ─── ユーティリティ ──────────────────────────────────────────
/** HTML エスケープ (XSS 防止) */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 今日の日付文字列 YYYY-MM-DD */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 曜日文字列 (0=sun … 6=sat) → 'sun'|'mon'|… */
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** ユニーク ID */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 配列からランダム 1 つ (直前と異なるものを優先) */
function pickRandom(arr, prev) {
  if (!arr || arr.length === 0) return '';
  const candidates = arr.length > 1 ? arr.filter(x => x !== prev) : arr;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** toast メッセージ表示 */
function showToast(text) {
  const el = document.createElement('div');
  el.className = 'reward-toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ─── デフォルト状態 ───────────────────────────────────────────
const DEFAULT_STATE = {
  version: 1,
  player: { name: 'ぴな' },
  character: {
    name: 'ミナト',
    personality: 'tsundere',
    firstPerson: 'わたし',
    callName: 'ぴな',
    suffix: '',
    look: {
      hairStyle: 'long',
      hairColor: '#6b4f3a',
      eyeColor: '#4a6fa5',
      skinTone: '#ffe3cf',
      outfitColor: '#e8718d',
      accessory: 'none'
    }
  },
  affection: 0,
  coins: 0,
  // 自分のパラメーター (ときメモ式)。タスク完了でカテゴリのパラメーターが上がる
  params: { int: 0, fit: 0, life: 0, sense: 0, grit: 0 },
  streak: { current: 0, best: 0, lastAllDoneDate: null },
  tasks: [],
  memories: [],
  stats: {
    totalCompleted: 0,
    totalCoinsEarned: 0,
    totalGifts: 0,
    totalDates: 0
  },
  // FocusFlow 連携 (同一オリジンの localStorage 'ff-tasks' を共有)
  ff: { enabled: true, initialized: false, rewardedIds: [] },
  lastVisit: null
};

// ─── 状態管理 ────────────────────────────────────────────────
const STORAGE_KEY = 'isshogurashi_v1';
let state = null;
let _lastBubbleText = '';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // バージョン確認・マージ
      state = Object.assign({}, DEFAULT_STATE, parsed);
      state.player = Object.assign({}, DEFAULT_STATE.player, parsed.player);
      state.character = Object.assign({}, DEFAULT_STATE.character, parsed.character);
      state.character.look = Object.assign({}, DEFAULT_STATE.character.look, (parsed.character || {}).look);
      state.streak = Object.assign({}, DEFAULT_STATE.streak, parsed.streak);
      state.stats = Object.assign({}, DEFAULT_STATE.stats, parsed.stats);
      state.ff = Object.assign({}, DEFAULT_STATE.ff, parsed.ff);
      state.params = Object.assign({}, DEFAULT_STATE.params, parsed.params);
      if (!Array.isArray(state.ff.rewardedIds)) state.ff.rewardedIds = [];
      if (!Array.isArray(state.tasks)) state.tasks = [];
      if (!Array.isArray(state.memories)) state.memories = [];
    } else {
      state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
  } catch (e) {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // localStorage 容量超過等は無視
  }
}

function isSetupDone() {
  return state.lastVisit !== null;
}

// ─── 日付ロールオーバー ─────────────────────────────────────────
function doRollover() {
  const today = todayStr();
  if (state.lastVisit === today) return false; // 同じ日

  const wasAway = state.lastVisit !== null &&
    (new Date(today) - new Date(state.lastVisit)) / 86400000 >= 2;

  // タスクは FocusFlow システム (ff-tasks) が管理するためここでは触らない
  state.lastVisit = today;
  saveState();
  return wasAway;
}

// ─── FocusFlow タスクシステム連携 ────────────────────────────────
// タスクの管理 UI とデータ書き込みは js/focusflow.js (FocusFlow 移植版) が
// 担当する (localStorage キー 'ff-tasks')。app.js は読み取りと報酬付与のみ。
// FFX の save() が毎回 App.onTasksChanged() を呼ぶので、アプリ内完了・
// LINE 取り込み・別タブ更新のすべてが同じ経路で検知される。
const FF_KEY = 'ff-tasks';
// FocusFlow の緊急度 → 報酬難易度
const FF_DIFFICULTY = { must: 'hard', want: 'normal', nice: 'easy' };
const FF_URGENCY_LABELS = { must: '絶対', want: 'やりたい', nice: '余力' };

function ffLoadTasks() {
  try {
    const arr = JSON.parse(localStorage.getItem(FF_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function ffTaskTitle(t) {
  return t.title || t.text || '';
}

/** 今日対象のタスク (「後日実行予定」は除く) */
function ffActiveTasks() {
  return ffLoadTasks().filter(t => t && t.urgency !== 'scheduled');
}

/** 初回連携時: 既に完了済みのタスクには報酬を出さない */
function ffEnsureInitialized() {
  if (state.ff.initialized || localStorage.getItem(FF_KEY) === null) return;
  state.ff.rewardedIds = ffLoadTasks().filter(t => t.done && t.id).map(t => t.id);
  state.ff.initialized = true;
  saveState();
}

function ffRewardFor(task) {
  const eco = getEconomy();
  const diff = FF_DIFFICULTY[task.urgency] || 'normal';
  return { coins: eco.coins[diff] || 20, affection: eco.affection[diff] || 4 };
}

/** タスクのパラメーターカテゴリ (手動設定 > キーワード自動分類) */
function taskParamCategory(task) {
  if (task.category && state.params.hasOwnProperty(task.category)) return task.category;
  if (typeof GameData !== 'undefined' && GameData.classifyTask) {
    return GameData.classifyTask(ffTaskTitle(task));
  }
  return 'grit';
}

/** 緊急度に応じたパラメーター上昇量 */
function paramGainFor(task) {
  const gains = (typeof GameData !== 'undefined' && GameData.PARAM_GAIN) || { must: 3, want: 2, nice: 1 };
  return gains[task.urgency] || 2;
}

/** トースト用のパラメーター上昇表示 (例: '📚+3 💪+2') */
function paramGainLabel(paramGains) {
  if (typeof GameData === 'undefined') return '';
  return GameData.PARAMS
    .filter(p => paramGains[p.id])
    .map(p => `${p.icon}+${paramGains[p.id]}`)
    .join(' ');
}

/** 完了されたタスクを検知して、まとめて報酬を出す (FFX の保存毎に呼ばれる) */
let _knownTaskIds = null; // 新規追加検知用 (メモリのみ)

function ffCheckExternalCompletions() {
  if (state == null) return; // 起動順による未初期化ガード
  ffEnsureInitialized();
  const tasks = ffLoadTasks();
  const rewarded = new Set(state.ff.rewardedIds);
  const newly = tasks.filter(t => t && t.done && t.id && !rewarded.has(t.id));

  // 新規追加されたタスクには task_add のセリフで反応 (初回ロード時は記憶だけ)
  if (_knownTaskIds === null) {
    _knownTaskIds = new Set(tasks.map(t => t && t.id));
  } else {
    const added = tasks.filter(t => t && t.id && !t.done && !_knownTaskIds.has(t.id));
    tasks.forEach(t => { if (t && t.id) _knownTaskIds.add(t.id); });
    if (added.length > 0 && newly.length === 0) {
      const speech = getSpeech('task_add', { task: ffTaskTitle(added[added.length - 1]) });
      showBubble(speech);
      renderChara('home-chara', 'smile');
    }
  }

  if (newly.length > 0) {
    let coins = 0;
    let aff = 0;
    const paramGains = {}; // paramId → 上昇量
    newly.forEach(t => {
      const r = ffRewardFor(t);
      coins += r.coins;
      aff += r.affection;
      state.ff.rewardedIds.push(t.id);
      // パラメーター上昇 (カテゴリ未設定はタイトルから自動分類)
      const cat = taskParamCategory(t);
      const gain = paramGainFor(t);
      state.params[cat] = (state.params[cat] || 0) + gain;
      paramGains[cat] = (paramGains[cat] || 0) + gain;
    });
    const prevAff = state.affection;
    state.coins += coins;
    state.affection += aff;
    state.stats.totalCoinsEarned += coins;
    state.stats.totalCompleted += newly.length;
    checkLevelUp(prevAff);

    // セリフ: 1件完了なら 40% でパラメーター褒め、それ以外は task_complete
    const last = newly[newly.length - 1];
    const lastCat = taskParamCategory(last);
    let speech;
    if (newly.length === 1 && Math.random() < 0.4 && typeof Dialogue !== 'undefined' && Dialogue.praise) {
      speech = Dialogue.praise(lastCat, state);
    } else {
      speech = getSpeech('task_complete', { task: ffTaskTitle(last) });
    }
    _lastBubbleText = speech;
    showBubble(speech);
    renderChara('home-chara', 'joy');
    showToast(`🪙+${coins} ✨+${aff} ${paramGainLabel(paramGains)}`);

    if (isEverythingDoneToday()) handleAllDone(getEconomy());
  }

  // FocusFlow 側で削除されたタスクの ID は掃除する
  const existing = new Set(tasks.map(t => t && t.id));
  state.ff.rewardedIds = state.ff.rewardedIds.filter(id => existing.has(id));
  saveState();

  refreshHomeTaskList();
  refreshStatusBar();
}

/** 今日のタスクが全部完了しているか */
function isEverythingDoneToday() {
  const ff = ffActiveTasks();
  if (ff.length === 0) return false;
  return ff.every(t => t.done);
}

// ─── 時間帯 ───────────────────────────────────────────────────
function getTimeSlot() {
  const h = new Date().getHours();
  if (h >= 5  && h < 10) return 'morning';
  if (h >= 10 && h < 17) return 'day';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

function getGreetingSituation() {
  const slot = getTimeSlot();
  return `greeting_${slot}`;
}

// ─── 表情 ─────────────────────────────────────────────────────
function getDefaultExpression() {
  const slot = getTimeSlot();
  if (slot === 'night') return 'sleepy';
  if (isEverythingDoneToday()) return 'smile';
  return 'normal';
}

// ─── セリフ取得 ─────────────────────────────────────────────────
function getSpeech(situation, extra) {
  if (typeof Dialogue === 'undefined') return '…';
  return Dialogue.get(situation, state, extra || {});
}

// ─── キャラ立ち絵描画 ─────────────────────────────────────────
function renderChara(containerId, expression) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (typeof CharacterArt === 'undefined') {
    el.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:40px">🧑</div>';
    return;
  }
  el.innerHTML = CharacterArt.render(state.character.look, expression || 'normal');
}

// ─── 吹き出し表示 ──────────────────────────────────────────────
function showBubble(text) {
  const bubble = document.getElementById('home-bubble');
  const textEl = document.getElementById('home-bubble-text');
  if (!bubble || !textEl) return;
  textEl.textContent = text; // textContent で XSS 防止
  bubble.classList.remove('hidden');
  // 5 秒後に消す
  clearTimeout(showBubble._timer);
  showBubble._timer = setTimeout(() => {
    bubble.classList.add('hidden');
  }, 5000);
}

// ─── レベルアップ検知 ──────────────────────────────────────────
function checkLevelUp(prevAffection) {
  if (typeof GameData === 'undefined') return;
  const prevLv = GameData.levelFor(prevAffection);
  const newLv  = GameData.levelFor(state.affection);
  if (newLv.lv > prevLv.lv) {
    // memories 記録
    state.memories.unshift({
      date: todayStr(),
      type: 'levelup',
      label: `「${esc(newLv.name)}」になりました！`
    });
    saveState();
    // 演出
    showLevelUpOverlay(newLv);
  }
}

function showLevelUpOverlay(lvEntry) {
  const overlay = document.getElementById('levelup-overlay');
  const nameEl  = document.getElementById('levelup-name');
  if (!overlay || !nameEl) return;
  nameEl.textContent = `「${lvEntry.name}」`;
  renderChara('levelup-chara', 'joy');
  overlay.classList.remove('hidden');
  // セリフも更新
  const text = getSpeech('levelup');
  setTimeout(() => showBubble(text), 500);
}

// ─── 経済設定 ─────────────────────────────────────────────────
function getEconomy() {
  return (typeof GameData !== 'undefined') ? GameData.ECONOMY : {
    coins: { easy: 10, normal: 20, hard: 40 },
    affection: { easy: 2, normal: 4, hard: 8 },
    allDoneCoins: 30, allDoneAffection: 5,
    streakBonusPerDay: 5, streakBonusCap: 50
  };
}

function handleAllDone(eco) {
  const today = todayStr();
  // 同日の二重付与を防止 (全完了後にタスクを追加して再完了した場合など)
  if (state.streak.lastAllDoneDate === today) return;
  // ストリーク更新
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;

  if (state.streak.lastAllDoneDate === yStr) {
    state.streak.current++;
  } else if (state.streak.lastAllDoneDate !== today) {
    state.streak.current = 1;
  }
  if (state.streak.current > state.streak.best) {
    state.streak.best = state.streak.current;
  }
  state.streak.lastAllDoneDate = today;

  // ストリークボーナス
  const bonus = Math.min(state.streak.current * (eco.streakBonusPerDay || 5), eco.streakBonusCap || 50);
  const prevAff = state.affection;
  state.coins += eco.allDoneCoins + bonus;
  state.affection += eco.allDoneAffection;
  state.stats.totalCoinsEarned += eco.allDoneCoins + bonus;
  checkLevelUp(prevAff);

  setTimeout(() => {
    const speech = getSpeech('all_done');
    showBubble(speech);
    renderChara('home-chara', 'smile');
    showToast(`🎉 全完了ボーナス +${eco.allDoneCoins + bonus}🪙`);
  }, 1200);
}

// ─── ホーム画面 ───────────────────────────────────────────────
function renderHome(comeback) {
  // 部屋背景
  const roomBg = document.getElementById('room-bg');
  if (roomBg) {
    roomBg.className = `room-bg time-${getTimeSlot()}`;
  }

  // ステータスバー
  refreshStatusBar();

  // 立ち絵
  const expr = getDefaultExpression();
  renderChara('home-chara', expr);

  // セリフ
  let situation;
  if (comeback) {
    situation = 'comeback';
  } else {
    // 未完了タスクが残っていて夕方以降
    const slot = getTimeSlot();
    const pending = ffActiveTasks();
    const hasOverdue = (slot === 'evening' || slot === 'night')
      && pending.length > 0
      && pending.some(t => !t.done);

    if (hasOverdue) {
      situation = 'has_overdue';
      renderChara('home-chara', 'pout');
    } else {
      situation = getGreetingSituation();
    }
  }
  const speech = getSpeech(situation);
  _lastBubbleText = speech;
  showBubble(speech);

  // 今日のタスク
  refreshHomeTaskList();
}

function refreshStatusBar() {
  const lvEl  = document.getElementById('home-level-name');
  const coinEl = document.getElementById('home-coins');
  const strEl  = document.getElementById('home-streak');
  if (typeof GameData !== 'undefined') {
    const lv = GameData.levelFor(state.affection);
    if (lvEl)  lvEl.textContent  = lv.name;
  }
  if (coinEl) coinEl.textContent = state.coins;
  if (strEl)  strEl.textContent  = state.streak.current;
}

function refreshHomeTaskList() {
  const container = document.getElementById('home-task-list');
  if (!container) return;
  const tasks = ffActiveTasks().filter(t => !t.done);
  if (tasks.length === 0) {
    container.innerHTML = '<p style="font-size:12px;color:var(--text-muted);padding:4px 0">今日のタスクは全部終わりました！タスクタブから追加できます。</p>';
    return;
  }
  container.innerHTML = tasks.map(t => `<div class="home-task-item">
    <button class="home-task-check" data-id="${esc(t.id)}" aria-label="完了"></button>
    <span class="home-task-label">${esc(ffTaskTitle(t))}</span>
    <span class="task-diff ff-${esc(t.urgency)}">${esc(FF_URGENCY_LABELS[t.urgency] || '')}</span>
  </div>`).join('');

  container.querySelectorAll('.home-task-check').forEach(btn => {
    btn.addEventListener('click', () => {
      // FFX 経由で完了 → save() → onTasksChanged で報酬付与
      if (window.FFX) FFX.toggleDone(btn.dataset.id);
    });
  });
}

// ─── プレゼントショップ ─────────────────────────────────────────
function renderShop() {
  const container = document.getElementById('gift-list');
  const coinsEl   = document.getElementById('shop-coins');
  if (!container) return;
  if (coinsEl) coinsEl.textContent = state.coins;

  if (typeof GameData === 'undefined') {
    container.innerHTML = '<p style="color:var(--text-muted);padding:20px">データを読み込み中…</p>';
    return;
  }

  const gifts = GameData.GIFTS;
  container.innerHTML = gifts.map(g => {
    const cantAfford = state.coins < g.price;
    return `<div class="gift-card${cantAfford ? ' cant-afford' : ''}">
      <div class="gift-icon">${esc(g.icon)}</div>
      <div class="gift-name">${esc(g.name)}</div>
      <div class="gift-price">🪙${g.price}</div>
      <div class="gift-affection">💛+${g.affection}</div>
      <button class="buy-btn" data-id="${esc(g.id)}"${cantAfford ? ' disabled' : ''}>
        ${cantAfford ? 'コイン不足' : 'プレゼント'}
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('.buy-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => buyGift(btn.dataset.id));
  });
}

function buyGift(giftId) {
  if (typeof GameData === 'undefined') return;
  const gift = GameData.GIFTS.find(g => g.id === giftId);
  if (!gift) return;
  if (state.coins < gift.price) return;

  state.coins -= gift.price;
  const prevAff = state.affection;
  state.affection += gift.affection;
  // 購入はコイン消費 (totalCoinsEarned は獲得分のみカウント)
  state.stats.totalGifts++;
  checkLevelUp(prevAff);

  // リアクション
  const personality = state.character.personality;
  const reactions = (gift.reactions && gift.reactions[personality]) || ['ありがとう…'];
  const rawText = pickRandom(reactions, null);
  const text = (typeof Dialogue !== 'undefined') ? Dialogue.format(rawText, state) : rawText;

  // memories
  state.memories.unshift({
    date: todayStr(),
    type: 'gift',
    label: `${gift.icon}${gift.name}をプレゼントした`
  });

  saveState();

  // UI 更新
  renderChara('home-chara', Math.random() < 0.5 ? 'joy' : 'blush');
  showBubble(text);
  showToast(`${gift.icon} ${gift.name}をプレゼント！`);
  renderShop();
  refreshStatusBar();

  // ホームに戻る
  switchTab('home');
}

// ─── おでかけ (デートスポット一覧) ──────────────────────────────
function renderDateSpots() {
  const container = document.getElementById('date-spot-list');
  const coinsEl   = document.getElementById('date-coins');
  if (!container) return;
  if (coinsEl) coinsEl.textContent = state.coins;

  if (typeof GameData === 'undefined') {
    container.innerHTML = '<p style="color:var(--text-muted);padding:20px">データを読み込み中…</p>';
    return;
  }

  const spots = GameData.DATE_SPOTS;
  const currentLv = (typeof GameData !== 'undefined') ? GameData.levelFor(state.affection).lv : 1;

  container.innerHTML = spots.map(spot => {
    const lvLocked   = currentLv < spot.minLevel;
    const statLocked = !spotStatOk(spot);
    const locked     = lvLocked || statLocked;
    const noCoins    = state.coins < spot.price;
    const disabled   = locked || noCoins;
    const lockMsg = lvLocked ? `Lv${spot.minLevel} で解放`
      : statLocked ? `${statReqLabel(spot)}で解放`
      : noCoins ? 'コイン不足' : '';

    return `<div class="spot-card${locked ? ' locked' : ''}">
      <div class="spot-icon">${esc(spot.icon)}</div>
      <div class="spot-body">
        <div class="spot-name">${esc(spot.name)}</div>
        <div class="spot-info">
          <span class="spot-price">🪙${spot.price}</span>
          <span class="spot-affection">💛+${spot.affection}</span>
          ${lockMsg ? `<span class="spot-lock">🔒 ${esc(lockMsg)}</span>` : ''}
        </div>
        <button class="go-btn" data-id="${esc(spot.id)}"${disabled ? ' disabled' : ''}>
          ${locked ? '🔒 ロック中' : noCoins ? 'コイン不足' : 'おでかけ！'}
        </button>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.go-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => startDate(btn.dataset.id));
  });
}

// ─── デート VN ────────────────────────────────────────────────
let vnState = null; // { spot, beatIndex }

/** デートスポットのステータス条件 (例: 感性3以上) を満たしているか */
function spotStatOk(spot) {
  if (!spot.statReq) return true;
  return (state.params[spot.statReq.param] || 0) >= spot.statReq.value;
}

/** 'カテゴリ名+必要値' のラベル (例: '🎨感性3') */
function statReqLabel(spot) {
  if (!spot.statReq || typeof GameData === 'undefined') return '';
  const p = GameData.PARAMS.find(p => p.id === spot.statReq.param);
  return p ? `${p.icon}${p.name}${spot.statReq.value}` : '';
}

function startDate(spotId) {
  if (typeof GameData === 'undefined') return;
  const spot = GameData.DATE_SPOTS.find(s => s.id === spotId);
  if (!spot) return;
  if (state.coins < spot.price) return;
  if (GameData.levelFor(state.affection).lv < spot.minLevel || !spotStatOk(spot)) return;

  state.coins -= spot.price;
  saveState();

  vnState = { spot, beatIndex: 0 };

  // VN 画面に切替
  document.getElementById('screen-main').classList.add('hidden');
  const vnScreen = document.getElementById('screen-date-vn');
  vnScreen.classList.remove('hidden');

  // 背景
  const vnBg = document.getElementById('vn-bg');
  if (vnBg) vnBg.className = `vn-bg ${esc(spot.bgClass || '')}`;

  renderVNBeat();
}

function renderVNBeat() {
  if (!vnState) return;
  const { spot, beatIndex } = vnState;
  if (beatIndex >= spot.script.length) {
    // シーン終了
    endDate();
    return;
  }
  const beat = spot.script[beatIndex];
  const personality = state.character.personality;

  const speakerEl = document.getElementById('vn-speaker');
  const textEl    = document.getElementById('vn-text');

  if (beat.speaker === 'narration') {
    if (speakerEl) speakerEl.textContent = '';
    const raw = typeof beat.lines === 'string' ? beat.lines : (beat.lines[personality] || '');
    const formatted = (typeof Dialogue !== 'undefined') ? Dialogue.format(raw, state) : raw;
    if (textEl) textEl.textContent = formatted;
    renderChara('vn-chara', 'normal');
  } else {
    if (speakerEl) speakerEl.textContent = state.character.name;
    const raw = (beat.lines && beat.lines[personality]) ? beat.lines[personality] : '';
    const formatted = (typeof Dialogue !== 'undefined') ? Dialogue.format(raw, state) : raw;
    if (textEl) textEl.textContent = formatted;
    // 表情
    const expr = beatIndex === 0 ? 'smile' : beatIndex % 3 === 0 ? 'blush' : 'smile';
    renderChara('vn-chara', expr);
  }
}

function advanceVN() {
  if (!vnState) return;
  vnState.beatIndex++;
  renderVNBeat();
}

function endDate() {
  if (!vnState) return;
  const spot = vnState.spot;
  const prevAff = state.affection;
  state.affection += spot.affection;
  state.stats.totalDates++;
  checkLevelUp(prevAff);

  // memories
  state.memories.unshift({
    date: todayStr(),
    type: 'date',
    label: `${spot.icon}${spot.name}に行った`
  });
  saveState();

  vnState = null;

  // メイン画面に戻る
  document.getElementById('screen-date-vn').classList.add('hidden');
  document.getElementById('screen-main').classList.remove('hidden');

  // ホームに戻ってリアクション
  switchTab('home');
  renderChara('home-chara', 'joy');
  const speech = getSpeech('greeting_day');
  showBubble(speech);
  showToast(`${spot.icon} デート終了！ 💛+${spot.affection}`);
  renderDateSpots();
  refreshStatusBar();
}

// ─── きろく ──────────────────────────────────────────────────
/** きろく: パラメーターのレーダーチャート (SVG 五角形) と一覧 */
function renderParamChart() {
  const radarEl = document.getElementById('param-radar');
  const listEl  = document.getElementById('param-list');
  if (!radarEl || typeof GameData === 'undefined') return;

  const params = GameData.PARAMS;
  const vals = params.map(p => state.params[p.id] || 0);
  // 軸の最大値: 10 刻みで切り上げ (最低 10)
  const maxV = Math.max(10, Math.ceil(Math.max.apply(null, vals) / 10) * 10);

  const cx = 110, cy = 95, R = 64;
  const point = (i, ratio) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI / params.length);
    return [cx + R * ratio * Math.cos(ang), cy + R * ratio * Math.sin(ang)];
  };
  const ringPoly = ratio =>
    params.map((_, i) => point(i, ratio).map(v => v.toFixed(1)).join(',')).join(' ');

  // 目盛り 3 リング + 軸線
  let svg = '';
  [1, 2 / 3, 1 / 3].forEach(r => {
    svg += `<polygon points="${ringPoly(r)}" fill="none" stroke="var(--border-mid)" stroke-width="1"/>`;
  });
  params.forEach((_, i) => {
    const [x, y] = point(i, 1);
    svg += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--border-mid)" stroke-width="1"/>`;
  });

  // 値ポリゴン
  const valPoly = params.map((p, i) =>
    point(i, (state.params[p.id] || 0) / maxV).map(v => v.toFixed(1)).join(',')
  ).join(' ');
  svg += `<polygon points="${valPoly}" fill="rgba(232,113,141,0.35)" stroke="var(--pink-dark)" stroke-width="2" stroke-linejoin="round"/>`;

  // 軸ラベル (アイコン+値)
  params.forEach((p, i) => {
    const [x, y] = point(i, 1.27);
    svg += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="13">${p.icon}${state.params[p.id] || 0}</text>`;
  });

  radarEl.innerHTML = `<svg viewBox="0 0 220 190" role="img" aria-label="パラメーター">${svg}</svg>`;

  if (listEl) {
    listEl.innerHTML = params.map(p => {
      const v = state.params[p.id] || 0;
      return `<div class="param-row">
        <span class="param-name">${p.icon} ${esc(p.name)}</span>
        <div class="param-bar-bg"><div class="param-bar-fill" style="width:${Math.min(100, v / maxV * 100)}%"></div></div>
        <span class="param-val">${v}</span>
      </div>`;
    }).join('');
  }
}

function renderRecords() {
  if (typeof GameData === 'undefined') return;
  renderParamChart();
  const lv = GameData.levelFor(state.affection);
  const levels = GameData.LEVELS;
  const lvIdx  = levels.findIndex(l => l.lv === lv.lv);
  const nextLv = levels[lvIdx + 1];

  const nameEl   = document.getElementById('rec-level-name');
  const barEl    = document.getElementById('rec-affection-bar');
  const curEl    = document.getElementById('rec-affection-cur');
  const nextEl   = document.getElementById('rec-affection-next');

  if (nameEl) nameEl.textContent = lv.name;
  if (curEl)  curEl.textContent  = `${state.affection}`;
  if (nextEl) nextEl.textContent = nextLv ? `次: ${nextLv.min}` : 'MAX';

  if (barEl) {
    const from = lv.min;
    const to   = nextLv ? nextLv.min : lv.min + 1;
    const pct  = nextLv ? Math.min(100, ((state.affection - from) / (to - from)) * 100) : 100;
    barEl.style.width = `${pct}%`;
  }

  // 統計
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('rec-total-tasks',  state.stats.totalCompleted);
  set('rec-total-coins',  state.stats.totalCoinsEarned);
  set('rec-total-gifts',  state.stats.totalGifts);
  set('rec-total-dates',  state.stats.totalDates);
  set('rec-streak',       state.streak.current);
  set('rec-best-streak',  state.streak.best);

  // 思い出タイムライン
  const memoriesEl = document.getElementById('memories-list');
  if (memoriesEl) {
    if (state.memories.length === 0) {
      memoriesEl.innerHTML = '<p style="font-size:13px;color:var(--text-muted);padding:8px 0">まだ思い出がありません</p>';
    } else {
      const icons = { gift: '🎁', date: '🌸', levelup: '⭐' };
      memoriesEl.innerHTML = state.memories.map(m => {
        return `<div class="memory-item">
          <div class="memory-icon">${icons[m.type] || '💝'}</div>
          <div class="memory-body">
            <div class="memory-label">${esc(m.label)}</div>
            <div class="memory-date">${esc(m.date)}</div>
          </div>
        </div>`;
      }).join('');
    }
  }
}

// ─── せってい ────────────────────────────────────────────────
function initSettingsTab() {
  // 現在値を読み込んでフォームに反映
  const ch = state.character;

  // 立ち絵プレビュー
  renderChara('settings-chara-preview', 'smile');

  // 色
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal('s2-hair',   ch.look.hairColor);
  setVal('s2-eye',    ch.look.eyeColor);
  setVal('s2-skin',   ch.look.skinTone);
  setVal('s2-outfit', ch.look.outfitColor);

  // テキスト
  setVal('s2-charName',   ch.name);
  setVal('s2-playerName', state.player.name);
  setVal('s2-callName',   ch.callName);
  setVal('s2-firstPerson', ch.firstPerson);
  setVal('s2-suffix',     ch.suffix);

  // 髪型
  buildChipGroup('settings-hairStyle-select', CharacterArt ? CharacterArt.HAIR_STYLES : [], ch.look.hairStyle, v => {
    state.character.look.hairStyle = v;
    renderSettingsPreview();
  });

  // アクセ
  buildChipGroup('settings-accessory-select', CharacterArt ? CharacterArt.ACCESSORIES : [], ch.look.accessory, v => {
    state.character.look.accessory = v;
    renderSettingsPreview();
  });

  // 性格
  buildPersonalityGrid('settings-personality-grid', ch.personality, v => {
    state.character.personality = v;
  });

}

function renderSettingsPreview() {
  // 設定フォームの値を一時的に look に反映してプレビュー
  const look = Object.assign({}, state.character.look);
  const get = id => { const el = document.getElementById(id); return el ? el.value : null; };
  if (get('s2-hair'))   look.hairColor  = get('s2-hair');
  if (get('s2-eye'))    look.eyeColor   = get('s2-eye');
  if (get('s2-skin'))   look.skinTone   = get('s2-skin');
  if (get('s2-outfit')) look.outfitColor = get('s2-outfit');

  const el = document.getElementById('settings-chara-preview');
  if (!el) return;
  if (typeof CharacterArt !== 'undefined') {
    el.innerHTML = CharacterArt.render(look, 'smile');
  }
}

function saveSettings() {
  const get = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  state.character.name        = get('s2-charName')   || state.character.name;
  state.player.name           = get('s2-playerName') || state.player.name;
  state.character.callName    = get('s2-callName')   || state.character.callName;
  state.character.firstPerson = get('s2-firstPerson') || state.character.firstPerson;
  state.character.suffix      = get('s2-suffix');
  state.character.look.hairColor   = get('s2-hair')   || state.character.look.hairColor;
  state.character.look.eyeColor    = get('s2-eye')    || state.character.look.eyeColor;
  state.character.look.skinTone    = get('s2-skin')   || state.character.look.skinTone;
  state.character.look.outfitColor = get('s2-outfit') || state.character.look.outfitColor;

  saveState();
  renderChara('home-chara', 'smile');
  showBubble('設定を更新したよ！');
  showToast('設定を保存しました ✓');
  switchTab('home');
}

// ─── セットアップウィザード ────────────────────────────────────
let wizardLook = {};
let wizardPersonality = 'tsundere';
let wizardStep = 1;

function initWizard() {
  wizardLook = JSON.parse(JSON.stringify(DEFAULT_STATE.character.look));

  // Step1: 髪型チップ
  buildChipGroup('hairStyle-select', CharacterArt ? CharacterArt.HAIR_STYLES : [], wizardLook.hairStyle, v => {
    wizardLook.hairStyle = v;
    renderWizardPreview();
  });

  // アクセサリーチップ
  buildChipGroup('accessory-select', CharacterArt ? CharacterArt.ACCESSORIES : [], wizardLook.accessory, v => {
    wizardLook.accessory = v;
    renderWizardPreview();
  });

  // カラーピッカー
  const colorIds = [
    ['c-hair',   'hairColor'],
    ['c-eye',    'eyeColor'],
    ['c-skin',   'skinTone'],
    ['c-outfit', 'outfitColor']
  ];
  colorIds.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = wizardLook[key];
    el.addEventListener('input', () => {
      wizardLook[key] = el.value;
      renderWizardPreview();
    });
  });

  // プレビュー初期描画
  renderWizardPreview();

  // Step2: 性格
  buildPersonalityGrid('personality-grid', wizardPersonality, v => {
    wizardPersonality = v;
  });

  // ステップドット番号
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.textContent = i + 1;
  });
}

function renderWizardPreview() {
  const el = document.getElementById('setup-chara-preview');
  if (!el) return;
  if (typeof CharacterArt !== 'undefined') {
    el.innerHTML = CharacterArt.render(wizardLook, 'smile');
  } else {
    el.innerHTML = '<div style="font-size:40px;text-align:center;padding-top:40px">🧑</div>';
  }
}

function goToStep(n) {
  wizardStep = n;
  document.querySelectorAll('.setup-step').forEach((el, i) => {
    el.classList.toggle('active', i + 1 === n);
  });
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    const stepNum = i + 1;
    dot.classList.remove('active', 'done');
    if (stepNum < n) dot.classList.add('done');
    else if (stepNum === n) dot.classList.add('active');
  });
}

function finishSetup() {
  const charName    = (document.getElementById('s-charName') || {}).value || 'ミナト';
  const playerName  = (document.getElementById('s-playerName') || {}).value || 'ぴな';
  const callName    = (document.getElementById('s-callName') || {}).value || playerName;
  const firstPerson = (document.getElementById('s-firstPerson') || {}).value || 'わたし';
  const suffix      = (document.getElementById('s-suffix') || {}).value || '';

  state.character.name        = charName.trim() || 'ミナト';
  state.player.name           = playerName.trim() || 'ぴな';
  state.character.callName    = callName.trim() || state.player.name;
  state.character.firstPerson = firstPerson.trim() || 'わたし';
  state.character.suffix      = suffix.trim();
  state.character.personality = wizardPersonality;
  state.character.look        = Object.assign({}, wizardLook);
  state.lastVisit             = todayStr();

  // FocusFlow の既存完了タスクには報酬を出さないよう先に初期化
  ffEnsureInitialized();

  saveState();

  // セットアップ画面を隠してメインを表示
  document.getElementById('screen-setup').classList.add('hidden');
  document.getElementById('screen-main').classList.remove('hidden');

  renderHome(false);

  // setup_first セリフ
  setTimeout(() => {
    const speech = getSpeech('setup_first');
    showBubble(speech);
    renderChara('home-chara', 'smile');
  }, 300);
}

// ─── チップグループビルダー ─────────────────────────────────────
function buildChipGroup(containerId, items, activeValue, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = items.map(item =>
    `<button class="chip${item.id === activeValue ? ' active' : ''}" data-value="${esc(item.id)}">${esc(item.name)}</button>`
  ).join('');
  container.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      onSelect(btn.dataset.value);
    });
  });
}

// 性格パネル サンプルセリフ (フォールバック)
const PERSONALITY_SAMPLES = {
  tsundere: 'べ、別にあなたのためじゃないんだから！',
  cool:     '…なるほど。では、手伝いましょうか。',
  caring:   'えらい！頑張ったね、ゆっくり休んでね。',
  genki:    'いけるいける！一緒に頑張ろーっ！',
  sweet:    'ねえねえ、もっと一緒にいようよ〜！'
};

const PERSONALITY_NAMES = {
  tsundere: 'ツンデレ',
  cool:     'クール',
  caring:   '世話焼き',
  genki:    '元気',
  sweet:    '甘えん坊'
};

const PERSONALITY_DESCS = {
  tsundere: '素直じゃないけど根は優しい',
  cool:     '落ち着いた敬語まじりで的確に',
  caring:   'おっとり優しくいつも褒めてくれる',
  genki:    '体育会系の応援団、テンション高め',
  sweet:    '甘えたくていつも一緒にいたがる'
};

function buildPersonalityGrid(containerId, activeValue, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const personalities = ['tsundere', 'cool', 'caring', 'genki', 'sweet'];
  container.innerHTML = personalities.map(p =>
    `<button class="personality-card${p === activeValue ? ' active' : ''}" data-value="${esc(p)}">
      <div class="personality-name">${esc(PERSONALITY_NAMES[p] || p)}</div>
      <div class="personality-desc">${esc(PERSONALITY_DESCS[p] || '')}</div>
      <div class="personality-sample">"${esc(PERSONALITY_SAMPLES[p] || '')}"</div>
    </button>`
  ).join('');
  container.querySelectorAll('.personality-card').forEach(card => {
    card.addEventListener('click', () => {
      container.querySelectorAll('.personality-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      onSelect(card.dataset.value);
    });
  });
}

// ─── タブ切替 ────────────────────────────────────────────────
let currentTab = 'home';

function switchTab(tabName) {
  currentTab = tabName;

  // タブセクション
  document.querySelectorAll('.tab-section').forEach(s => {
    s.classList.toggle('hidden', s.id !== `tab-${tabName}`);
  });

  // タブボタン
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });

  // タブごとの更新
  if (tabName === 'home') {
    refreshStatusBar();
    refreshHomeTaskList();
  } else if (tabName === 'tasks') {
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

// ─── イベント登録 ────────────────────────────────────────────
function bindEvents() {
  // タブバー
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ホーム：立ち絵クリック
  const homeChara = document.getElementById('home-chara');
  if (homeChara) {
    homeChara.addEventListener('click', () => {
      const speech = getSpeech('idle');
      _lastBubbleText = speech;
      showBubble(speech);
      renderChara('home-chara', 'smile');
    });
  }

  // ホーム：「すべて見る」ボタン
  const homeGotoTasks = document.getElementById('home-goto-tasks');
  if (homeGotoTasks) homeGotoTasks.addEventListener('click', () => switchTab('tasks'));

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

  // せってい: リセット
  const settingsReset = document.getElementById('settings-reset');
  if (settingsReset) settingsReset.addEventListener('click', showResetConfirm);

  // 確認ダイアログ: OK
  const confirmOk = document.getElementById('confirm-ok');
  if (confirmOk) {
    confirmOk.addEventListener('click', () => {
      document.getElementById('confirm-overlay').classList.add('hidden');
      resetData();
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
        renderHome(true);
      }
      // FocusFlow 側での完了を検知
      ffCheckExternalCompletions();
      refreshHomeTaskList();
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

// ─── リセット ────────────────────────────────────────────────
function showResetConfirm() {
  const msgEl = document.getElementById('confirm-message');
  if (msgEl) msgEl.textContent = 'すべてのデータ（キャラクター・タスク・思い出・コイン）が消えます。本当にリセットしますか？';
  const overlay = document.getElementById('confirm-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function resetData() {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
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

    renderHome(wasAway);

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

// グローバル公開 (任意)
window.App = {
  state, saveState, switchTab,
  // FFX (focusflow.js) の save() から毎回呼ばれる
  onTasksChanged: function () { ffCheckExternalCompletions(); }
};
