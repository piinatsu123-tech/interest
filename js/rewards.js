'use strict';

/* rewards.js — FocusFlow 連携・報酬・レベルアップ・パラメーター */

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
      showBubble(speech, 'smile');
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
    if (newly.length === 1 && Math.random() < 0.4 && typeof Dialogue !== 'undefined' && Dialogue.praiseObj) {
      speech = Dialogue.praiseObj(lastCat, state);
    } else {
      speech = getSpeech('task_complete', { task: ffTaskTitle(last) });
    }
    // ユーザーがタスクを完了したら、お部屋に移動してリアクションを見せる
    // (お部屋を開くと挨拶や休憩中の顔が入るので、その後にリアクションを上書きする)
    if (_pendingRoomJump && typeof openRoom === 'function') openRoom();
    _lastBubbleText = speech.text;
    showBubble(speech, 'joy');
    showToast(`🪙+${coins} ✨+${aff} ${paramGainLabel(paramGains)}`);

    if (isEverythingDoneToday()) handleAllDone(getEconomy());
  }
  _pendingRoomJump = false;

  // FocusFlow 側で削除されたタスクの ID は掃除する
  const existing = new Set(tasks.map(t => t && t.id));
  state.ff.rewardedIds = state.ff.rewardedIds.filter(id => existing.has(id));
  saveState();

  refreshStatusBar();
}

/** 今日のタスクが全部完了しているか */
/** その日のタスク完了の判定。
    「今日中に絶対 (must)」が 1 つでもあれば、それを全部終えた時点で「完了」。
    must が無い場合のみ、対象タスク全部の完了を見る。 */
function isEverythingDoneToday() {
  const active = ffActiveTasks();
  if (active.length === 0) return false;
  const must = active.filter(t => t.urgency === 'must');
  if (must.length > 0) return must.every(t => t.done);
  return active.every(t => t.done);
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
    showBubble(speech, 'smile');
    showToast(`🎉 全完了ボーナス +${eco.allDoneCoins + bonus}🪙`);
  }, 1200);
}
