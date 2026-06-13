'use strict';

/* core.js — ユーティリティ・状態管理・時間帯・確認ダイアログ */

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
      outfitStyle: 'dress',
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
  // 控えのキャラクター (アクティブは character/affection/memories に展開)
  roster: [],
  // おでかけ先のカスタム (標準スポットの上書き+自作スポット)
  customDates: [],
  // 時間帯 (挨拶と部屋の見た目)。start=開始時 (0-23)、base=トーン (朝昼夕夜)
  timeSlots: [
    { id: 'ts-m', start: 5,  name: 'あさ',   base: 'morning' },
    { id: 'ts-d', start: 10, name: 'ひる',   base: 'day' },
    { id: 'ts-e', start: 17, name: 'ゆうがた', base: 'evening' },
    { id: 'ts-n', start: 22, name: 'よる',   base: 'night' }
  ],
  // FocusFlow 連携 (同一オリジンの localStorage 'ff-tasks' を共有)
  ff: { enabled: true, initialized: false, rewardedIds: [] },
  lastVisit: null
};

// ─── 状態管理 ────────────────────────────────────────────────
const STORAGE_KEY = 'isshogurashi_v1';
let state = null;
let _lastBubbleText = '';
let _lastGreetSlotId = null; // この時間帯で挨拶済みか (タブ復帰時の再挨拶判定)
let _homeRestExpr = 'normal'; // セリフポップアップが消えたあとに戻す「休憩中」の表情

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
      if (!Array.isArray(state.roster)) state.roster = [];
      if (!Array.isArray(state.customDates)) state.customDates = [];
      state.timeSlots = sanitizeTimeSlots(parsed.timeSlots);
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
    // 容量超過 (画像立ち絵の入れすぎ等) は黙って失われると怖いので知らせる
    if (typeof showToast === 'function') {
      showToast('⚠️ 保存できません。画像立ち絵を減らしてください');
    }
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

// ─── 時間帯 (カスタマイズ可能) ──────────────────────────────────
const TIME_BASES = [
  { id: 'morning', name: '朝' },
  { id: 'day',     name: '昼' },
  { id: 'evening', name: '夕' },
  { id: 'night',   name: '夜' }
];
const TIMESLOT_MAX = 8;

/** 保存データの時間帯リストを検証・正規化 (壊れていたら標準に戻す) */
function sanitizeTimeSlots(raw) {
  const baseIds = TIME_BASES.map(b => b.id);
  const list = (Array.isArray(raw) ? raw : [])
    .filter(t => t && typeof t === 'object')
    .map(t => ({
      id: String(t.id || ('ts-' + uid())),
      start: Math.max(0, Math.min(23, parseInt(t.start, 10) || 0)),
      name: String(t.name || '').trim().slice(0, 8) || '時間帯',
      base: baseIds.includes(t.base) ? t.base : 'day'
    }))
    .slice(0, TIMESLOT_MAX);
  if (!list.length) return JSON.parse(JSON.stringify(DEFAULT_STATE.timeSlots));
  return list.sort((a, b) => a.start - b.start);
}

/** いまの時刻に当てはまる時間帯エントリ */
function currentTimeSlot() {
  const h = new Date().getHours();
  const slots = (state && state.timeSlots && state.timeSlots.length)
    ? state.timeSlots
    : DEFAULT_STATE.timeSlots;
  // start <= 現在時 の最後のスロット。どれにも当たらなければ最後 (深夜は前日の夜枠)
  let active = slots[slots.length - 1];
  for (const slot of slots) {
    if (slot.start <= h) active = slot;
  }
  return active;
}

/** 互換 API: 見た目トーン ('morning'|'day'|'evening'|'night') を返す */
function getTimeSlot() {
  return currentTimeSlot().base;
}

/** 挨拶の situation。スロット専用のカスタムセリフがあればそれを使う */
function getGreetingSituation() {
  const slot = currentTimeSlot();
  const cd = state.character.customDialogue;
  const key = 'slot:' + slot.id;
  if (cd && cd[key]) return key;
  return `greeting_${slot.base}`;
}

// ─── セリフ取得 ─────────────────────────────────────────────────
/** 現在のキャラのセリフを {text, expr} で返す。expr は登録された表情 ID (なければ null) */
function getSpeech(situation, extra) {
  if (typeof Dialogue === 'undefined') return { text: '…', expr: null };
  return Dialogue.getObj(situation, state, extra || {});
}

// ─── 確認ダイアログ (汎用) ──────────────────────────────────────
let _confirmCallback = null;

function showConfirm(title, message, okLabel, cb) {
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  const okEl = document.getElementById('confirm-ok');
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (okEl) okEl.textContent = okLabel;
  _confirmCallback = cb;
  const overlay = document.getElementById('confirm-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

// ─── リセット ────────────────────────────────────────────────
function showResetConfirm() {
  showConfirm('確認', 'すべてのデータ（キャラクター・タスク・思い出・コイン）が消えます。本当にリセットしますか？', 'リセットする', resetData);
}

function resetData() {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}
