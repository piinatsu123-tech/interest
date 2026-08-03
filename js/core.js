'use strict';

/* core.js — ユーティリティ・状態管理・確認ダイアログ
   タスク管理(FocusFlow / FlowClean / 期限切れ棚卸し)を支える最小限の共通処理のみ。
   キャラクター育成レイヤー(お部屋・セリフ・コイン・親密度など)は削除済み。
   復元が必要な場合は archive/isshogurashi ブランチを参照。 */

// ─── ユーティリティ ──────────────────────────────────────────
/** HTML エスケープ (XSS 防止)。flowclean.js から使用 */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 今日の日付文字列 YYYY-MM-DD。triage.js / focusflow.js から使用 */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** toast メッセージ表示。triage.js から使用 */
function showToast(text) {
  const el = document.createElement('div');
  el.className = 'reward-toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ─── 状態管理 ────────────────────────────────────────────────
// タスク本体は localStorage 'ff-tasks' (focusflow.js)、そうじの設定は 'fc_*'
// (flowclean.js) が持つ。ここで持つのは日付ロールオーバー用の lastVisit だけ。
const STORAGE_KEY = 'isshogurashi_v1';
const DEFAULT_STATE = { version: 2, lastVisit: null };

let state = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // 旧バージョン(キャラ育成データ入り)の保存データからは lastVisit だけ引き継ぐ
    state = { version: 2, lastVisit: parsed.lastVisit || null };
  } catch (e) {
    state = Object.assign({}, DEFAULT_STATE);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    if (typeof showToast === 'function') showToast('⚠️ 保存できませんでした');
  }
}

// ─── 日付ロールオーバー ─────────────────────────────────────────
/** 戻り値: { isNewDay }。isNewDay は「今日初めてのアクセスか」(棚卸しのトリガー) */
function doRollover() {
  const today = todayStr();
  if (state.lastVisit === today) return { isNewDay: false };
  state.lastVisit = today;
  saveState();
  return { isNewDay: true };
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
  showConfirm('確認', 'すべてのタスクとそうじの設定が消えます。本当にリセットしますか？', 'リセットする', resetData);
}

function resetData() {
  // タスク・そうじの設定も含めて消す (旧: いっしょぐらしの state だけだった)
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem('ff-tasks');
  ['fc_states', 'fc_env_list', 'fc_reward_images', 'fc_reward_msgs']
    .forEach(k => localStorage.removeItem(k));
  location.reload();
}
