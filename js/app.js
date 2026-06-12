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

// ─── SVG サニタイザー (フルカスタム立ち絵用) ─────────────────────
// インポートされた SVG から危険な要素・属性を除去する。許可リスト方式。
const SVG_ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'title', 'desc',
  'text', 'tspan'
]);
const SVG_ALLOWED_ATTRS = new Set([
  'viewbox', 'xmlns', 'id', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy',
  'r', 'rx', 'ry', 'width', 'height', 'points', 'offset', 'transform',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule',
  'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'clip-path', 'font-size', 'font-weight', 'text-anchor'
]);

/** <style> 要素と style 属性を、安全なプロパティだけ属性へインライン化する。
    チャット生成 SVG は class や style でスタイリングされがちで、除去だけだと
    真っ黒になるため。url()/javascript を含む値は捨てる */
function inlineSVGStyles(root) {
  const SAFE_PROPS = new Set(['fill', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity', 'stop-color', 'stop-opacity']);
  const safeVal = v => !/url\s*\(|javascript|expression|image/i.test(v);
  const parseDecls = (text) => {
    const decls = {};
    String(text || '').split(';').forEach(d => {
      const k = d.indexOf(':');
      if (k === -1) return;
      const prop = d.slice(0, k).trim().toLowerCase();
      const val = d.slice(k + 1).trim();
      if (SAFE_PROPS.has(prop) && safeVal(val)) decls[prop] = val;
    });
    return decls;
  };

  // <style> 内の .class { … } 規則を収集
  const rules = {};
  root.querySelectorAll('style').forEach(styleEl => {
    const css = styleEl.textContent || '';
    const re = /\.([\w-]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      rules[m[1]] = Object.assign(rules[m[1]] || {}, parseDecls(m[2]));
    }
  });

  const applyDecls = (el, decls) => {
    Object.keys(decls).forEach(prop => {
      if (!el.hasAttribute(prop)) el.setAttribute(prop, decls[prop]);
    });
  };
  if (Object.keys(rules).length) {
    root.querySelectorAll('[class]').forEach(el => {
      String(el.getAttribute('class') || '').split(/\s+/).forEach(cls => {
        if (rules[cls]) applyDecls(el, rules[cls]);
      });
    });
  }
  // style="fill:…" のインライン化
  [root, ...root.querySelectorAll('[style]')].forEach(el => {
    const st = el.getAttribute && el.getAttribute('style');
    if (st) applyDecls(el, parseDecls(st));
  });
}

/** SVG 文字列を許可リストでサニタイズ。安全な SVG 文字列か null を返す */
function sanitizeSVG(text) {
  const src = String(text || '').trim();
  if (!src || src.length > 100000) return null;

  // XML として読む → 壊れていたら HTML パーサーで <svg> を拾う (チャット出力に寛容に)
  let root = null;
  try {
    const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
    if (doc.documentElement && doc.documentElement.nodeName.toLowerCase() === 'svg'
        && !doc.querySelector('parsererror')) {
      root = doc.documentElement;
    }
  } catch (e) { /* fall through */ }
  if (!root) {
    try {
      root = new DOMParser().parseFromString(src, 'text/html').querySelector('svg');
    } catch (e) {
      return null;
    }
  }
  if (!root) return null;

  // class/<style>/style 属性のスタイルを安全な属性にインライン化 (除去前に)
  try { inlineSVGStyles(root); } catch (e) { /* スタイル変換失敗は無視 */ }

  // viewBox が無ければ width/height から合成 (強制 0 0 200 260 だと絵が見切れる)
  if (!root.getAttribute('viewBox')) {
    const w = parseFloat(root.getAttribute('width'));
    const h = parseFloat(root.getAttribute('height'));
    if (w > 0 && h > 0) {
      root.setAttribute('viewBox', `0 0 ${w} ${h}`);
    } else {
      root.setAttribute('viewBox', '0 0 200 260');
    }
  }

  const safeValue = (name, value) => {
    const v = String(value);
    if (/javascript:|data:|http/i.test(v)) return false;
    // url(...) は内部グラデーション/クリップ参照のみ許可
    if (/url\s*\(/i.test(v) && !/^url\(#[\w-]+\)$/.test(v.trim())) return false;
    return true;
  };

  const walk = (el) => {
    [...el.children].forEach(child => {
      if (!SVG_ALLOWED_TAGS.has(child.nodeName.toLowerCase())) {
        child.remove();
        return;
      }
      [...child.attributes].forEach(attr => {
        const n = attr.name.toLowerCase();
        if (!SVG_ALLOWED_ATTRS.has(n) || !safeValue(n, attr.value)) {
          child.removeAttribute(attr.name);
        }
      });
      walk(child);
    });
  };
  // ルート属性
  [...root.attributes].forEach(attr => {
    const n = attr.name.toLowerCase();
    if (!SVG_ALLOWED_ATTRS.has(n) || !safeValue(n, attr.value)) {
      root.removeAttribute(attr.name);
    }
  });
  root.removeAttribute('width');
  root.removeAttribute('height');
  walk(root);
  const out = new XMLSerializer().serializeToString(root);
  return out.length > 200000 ? null : out;
}

// ─── 保存済みカスタム SVG の viewBox 自動修復 ──────────────────
// 旧バージョンのサニタイザーは viewBox の無い SVG に 0 0 200 260 を強制して
// いたため、大きな座標系で描かれた立ち絵が見切れて「表示されない」状態になる。
// 起動時に実描画の bbox を測り、大きく外れていれば viewBox を合わせ直す。
function repairCustomArtViewBox() {
  const fixOne = (svgStr) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-9999px;top:0;width:200px;height:260px;visibility:hidden;';
    holder.innerHTML = svgStr;
    const svg = holder.querySelector('svg');
    if (!svg) return null;
    document.body.appendChild(holder);
    let fixed = null;
    try {
      const bb = svg.getBBox();
      const vb = (svg.getAttribute('viewBox') || '0 0 200 260').trim().split(/[\s,]+/).map(Number);
      if (bb.width > 0 && bb.height > 0 && vb.length === 4) {
        const clipped =
          bb.x + bb.width  > vb[0] + vb[2] * 1.5 ||
          bb.y + bb.height > vb[1] + vb[3] * 1.5 ||
          bb.x < vb[0] - vb[2] * 0.5 ||
          bb.y < vb[1] - vb[3] * 0.5;
        if (clipped) {
          const pad = Math.max(bb.width, bb.height) * 0.04;
          svg.setAttribute('viewBox',
            `${(bb.x - pad).toFixed(1)} ${(bb.y - pad).toFixed(1)} ${(bb.width + pad * 2).toFixed(1)} ${(bb.height + pad * 2).toFixed(1)}`);
          fixed = new XMLSerializer().serializeToString(svg);
        }
      }
    } catch (e) { /* getBBox 不可の環境では何もしない */ }
    holder.remove();
    return fixed;
  };

  let touched = false;
  const repairChar = (character) => {
    const art = character && character.customArt;
    if (!art || !art.base) return;
    const fixedBase = fixOne(art.base);
    if (fixedBase) { art.base = fixedBase; touched = true; }
    if (art.expressions) {
      Object.keys(art.expressions).forEach(k => {
        const f = fixOne(art.expressions[k]);
        if (f) { art.expressions[k] = f; touched = true; }
      });
    }
  };
  repairChar(state.character);
  (state.roster || []).forEach(e => repairChar(e.character));
  if (touched) {
    saveState();
    renderChara('home-chara', getDefaultExpression());
  }
}

// ─── キャラ立ち絵描画 ─────────────────────────────────────────
/** 立ち絵素材 1 枚分の HTML (dataURL 画像 or サニタイズ済み SVG 文字列) */
function artFragmentHTML(value) {
  if (typeof value === 'string' && value.indexOf('data:image/') === 0) {
    return `<img class="custom-art-img" src="${value}" alt="キャラクター">`;
  }
  return value; // sanitizeSVG 済みマークアップ
}

/** customArt の描画用 HTML。表情差分は SVG/画像を混在できる。
    SVG はインポート時にサニタイズ済み、dataUrl は保存時に形式検証済み */
function customArtHTML(art, expression) {
  const ex = expression || 'normal';
  const variant = art.expressions && art.expressions[ex];
  if (variant) return artFragmentHTML(variant);
  return artFragmentHTML(art.dataUrl || art.base);
}

function renderChara(containerId, expression) {
  const el = document.getElementById(containerId);
  if (!el) return;
  // フルカスタム立ち絵
  const art = state && state.character && state.character.customArt;
  if (art && (art.base || art.dataUrl)) {
    el.innerHTML = customArtHTML(art, expression);
    return;
  }
  if (typeof CharacterArt === 'undefined') {
    el.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:40px">🧑</div>';
    return;
  }
  el.innerHTML = CharacterArt.render(state.character.look, expression || 'normal');
}

/** プリセットセリフ用の性格 (カスタム時はベース性格に解決) */
function effectivePersonality() {
  if (typeof Dialogue !== 'undefined' && Dialogue.resolvePersonality) {
    return Dialogue.resolvePersonality(state);
  }
  return PERSONALITY_NAMES[state.character.personality] ? state.character.personality : 'tsundere';
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
  _lastGreetSlotId = currentTimeSlot().id;

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
  const custom = state.character.customDialogue;
  let reactions;
  if (custom && custom.gifts && Array.isArray(custom.gifts[gift.id]) && custom.gifts[gift.id].length) {
    // このプレゼント専用のカスタム反応
    reactions = custom.gifts[gift.id];
  } else if (custom && Array.isArray(custom.gift_reaction) && custom.gift_reaction.length) {
    reactions = custom.gift_reaction;
  } else {
    reactions = (gift.reactions && gift.reactions[effectivePersonality()]) || ['ありがとう…'];
  }
  let rawText = pickRandom(reactions, null).replace(/\{gift\}/g, gift.name);
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

  const spots = effectiveDateSpots();
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
      <button class="spot-edit-btn" data-id="${esc(spot.id)}" aria-label="シナリオを編集">✏️</button>
    </div>`;
  }).join('') + `
    <button class="btn-secondary date-add-btn" id="date-add-btn">＋ あたらしいおでかけ先をつくる</button>
    <div class="import-btn-row" style="margin-top:8px">
      <button class="btn-secondary" id="date-prompt-btn">💬 相談プロンプト</button>
      <button class="btn-secondary" id="date-import-btn">📥 台本をインポート</button>
    </div>`;

  container.querySelectorAll('.go-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => startDate(btn.dataset.id));
  });
  container.querySelectorAll('.spot-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openDateEditor(btn.dataset.id));
  });
  const addBtn = document.getElementById('date-add-btn');
  if (addBtn) addBtn.addEventListener('click', () => openDateEditor(null));
  const dpBtn = document.getElementById('date-prompt-btn');
  if (dpBtn) dpBtn.addEventListener('click', () => openPromptModal('dates'));
  const diBtn = document.getElementById('date-import-btn');
  if (diBtn) diBtn.addEventListener('click', () => openPartialImport('dates'));
}

/** 標準スポット (customDates の同 id で上書き) + 自作スポット */
function effectiveDateSpots() {
  const builtins = (typeof GameData !== 'undefined') ? GameData.DATE_SPOTS : [];
  const customs = state.customDates || [];
  const byId = {};
  customs.forEach(c => { byId[c.id] = c; });
  const merged = builtins.map(b => byId[b.id] || b);
  const extras = customs.filter(c => !builtins.some(b => b.id === c.id));
  return merged.concat(extras);
}

// ─── デートシナリオエディタ ──────────────────────────────────────
// 標準スポットの上書きも自作スポットも state.customDates に保存する。
const DATE_BG_OPTIONS = [
  { id: 'vn-cafe',      name: 'カフェ' },
  { id: 'vn-cinema',    name: '夜・屋内' },
  { id: 'vn-aquarium',  name: '水のなか' },
  { id: 'vn-amusement', name: '青空' },
  { id: 'vn-onsen',     name: '緑・自然' }
];
const DATE_CUSTOM_MAX = 12;

let dateEdId = null;        // 編集中のスポット id (null = 新規)
let dateEdBg = 'vn-cafe';
let dateEdLevel = 1;
let _dateEdReturnDraft = null; // 試し再生から戻るときの下書き

function openDateEditor(spotId) {
  const spot = spotId ? effectiveDateSpots().find(s => s.id === spotId) : null;
  openDateEditorWithDraft(spot ? {
    id: spot.id,
    name: spot.name,
    icon: spot.icon,
    price: spot.price,
    minLevel: spot.minLevel,
    affection: spot.affection,
    bgClass: spot.bgClass,
    script: spot.script.map(b => ({
      speaker: b.speaker === 'narration' ? 'narration' : 'char',
      text: typeof b.text === 'string' ? b.text
        : (typeof b.lines === 'string' ? b.lines : (b.lines && (b.lines[effectivePersonality()] || '')) || '')
    }))
  } : null);
}

/** 下書きオブジェクトからエディタを開く (試し再生からの復帰にも使う) */
function openDateEditorWithDraft(draft) {
  dateEdId = draft ? draft.id : null;
  const isBuiltin = dateEdId && (typeof GameData !== 'undefined') && GameData.DATE_SPOTS.some(b => b.id === dateEdId);
  const hasOverride = dateEdId && state.customDates.some(c => c.id === dateEdId);

  document.getElementById('ded-title').textContent = draft ? `${draft.name}を編集` : 'あたらしいおでかけ先';
  document.getElementById('ded-name').value  = draft ? draft.name : '';
  document.getElementById('ded-icon').value  = draft ? draft.icon : '🌟';
  document.getElementById('ded-price').value = draft ? draft.price : 200;
  document.getElementById('ded-aff').value   = draft ? draft.affection : 30;
  dateEdBg = (draft && draft.bgClass) || 'vn-cafe';
  dateEdLevel = (draft && draft.minLevel) || 1;

  buildChipGroup('ded-level-select',
    [1, 2, 3, 4, 5, 6].map(n => ({ id: String(n), name: `Lv${n}` })),
    String(dateEdLevel), v => { dateEdLevel = parseInt(v, 10); });
  buildChipGroup('ded-bg-select', DATE_BG_OPTIONS, dateEdBg, v => { dateEdBg = v; });

  dedRenderBeats(draft ? draft.script : [
    { speaker: 'narration', text: '' },
    { speaker: 'char', text: '' }
  ]);

  // 削除/標準に戻すボタン
  const delBtn = document.getElementById('ded-delete');
  if (isBuiltin && hasOverride) {
    delBtn.textContent = '↩️ 標準のシナリオに戻す';
    delBtn.classList.remove('hidden');
  } else if (dateEdId && !isBuiltin) {
    delBtn.textContent = '🗑️ このおでかけ先を削除';
    delBtn.classList.remove('hidden');
  } else {
    delBtn.classList.add('hidden');
  }

  document.getElementById('date-editor').classList.remove('hidden');
}

function dedRenderBeats(beats) {
  const el = document.getElementById('ded-beats');
  el.innerHTML = '';
  beats.forEach(b => dedAppendBeat(b.speaker, b.text));
}

function dedAppendBeat(speaker, text) {
  const el = document.getElementById('ded-beats');
  if (el.children.length >= 12) {
    showToast('台本は 12 コマまでです');
    return;
  }
  const row = document.createElement('div');
  row.className = 'ded-beat-row';
  row.dataset.speaker = speaker || 'char';
  row.innerHTML = `
    <div class="ded-beat-side">
      <button class="ded-speaker-toggle"></button>
      <button class="ded-beat-del" aria-label="削除">🗑️</button>
    </div>
    <textarea class="ded-beat-text" rows="2" maxlength="300"></textarea>`;
  const toggle = row.querySelector('.ded-speaker-toggle');
  const syncToggle = () => {
    const isNarr = row.dataset.speaker === 'narration';
    toggle.textContent = isNarr ? 'ナレ' : 'キャラ';
    toggle.classList.toggle('narration', isNarr);
  };
  syncToggle();
  toggle.addEventListener('click', () => {
    row.dataset.speaker = row.dataset.speaker === 'narration' ? 'char' : 'narration';
    syncToggle();
  });
  row.querySelector('.ded-beat-del').addEventListener('click', () => row.remove());
  row.querySelector('.ded-beat-text').value = text || '';
  el.appendChild(row);
}

/** フォームから下書きを組み立てる。不正なら null (トーストで通知) */
function dedCollectDraft() {
  const name = document.getElementById('ded-name').value.trim().slice(0, 12);
  if (!name) {
    showToast('なまえを入れてください');
    return null;
  }
  const icon = (document.getElementById('ded-icon').value.trim() || '🌟').slice(0, 4);
  const price = Math.max(0, Math.min(9999, parseInt(document.getElementById('ded-price').value, 10) || 0));
  const affection = Math.max(0, Math.min(100, parseInt(document.getElementById('ded-aff').value, 10) || 0));
  const script = [...document.querySelectorAll('#ded-beats .ded-beat-row')]
    .map(row => ({
      speaker: row.dataset.speaker === 'narration' ? 'narration' : 'char',
      text: row.querySelector('.ded-beat-text').value.trim().slice(0, 300)
    }))
    .filter(b => b.text);
  if (!script.length) {
    showToast('台本を 1 コマ以上書いてください');
    return null;
  }
  const draft = {
    id: dateEdId || ('cd-' + uid()),
    name, icon, price, affection,
    minLevel: dateEdLevel,
    bgClass: dateEdBg,
    script
  };
  // 標準スポットの上書きは statReq (ステータス解放条件) を引き継ぐ
  if (typeof GameData !== 'undefined') {
    const builtin = GameData.DATE_SPOTS.find(b => b.id === draft.id);
    if (builtin && builtin.statReq) draft.statReq = builtin.statReq;
  }
  return draft;
}

function dedSave() {
  const draft = dedCollectDraft();
  if (!draft) return;
  const idx = state.customDates.findIndex(c => c.id === draft.id);
  if (idx >= 0) {
    state.customDates[idx] = draft;
  } else {
    if (state.customDates.length >= DATE_CUSTOM_MAX) {
      showToast(`カスタムは${DATE_CUSTOM_MAX}件までです`);
      return;
    }
    state.customDates.push(draft);
  }
  saveState();
  closeDateEditor();
  renderDateSpots();
  showToast(`💾 「${draft.name}」を保存しました`);
}

function dedPreview() {
  const draft = dedCollectDraft();
  if (!draft) return;
  _dateEdReturnDraft = draft;
  closeDateEditor();
  // 試し再生 (コイン消費・報酬なし)
  vnState = { spot: draft, beatIndex: 0, preview: true };
  document.getElementById('screen-main').classList.add('hidden');
  const vnScreen = document.getElementById('screen-date-vn');
  vnScreen.classList.remove('hidden');
  const vnBg = document.getElementById('vn-bg');
  if (vnBg) vnBg.className = `vn-bg ${esc(draft.bgClass || '')}`;
  renderVNBeat();
}

function dedDelete() {
  const isBuiltin = (typeof GameData !== 'undefined') && GameData.DATE_SPOTS.some(b => b.id === dateEdId);
  const doIt = () => {
    state.customDates = state.customDates.filter(c => c.id !== dateEdId);
    saveState();
    closeDateEditor();
    renderDateSpots();
    showToast(isBuiltin ? '標準のシナリオに戻しました' : '削除しました');
  };
  if (isBuiltin) {
    doIt(); // 上書き解除は破壊的でないので即時
  } else {
    showConfirm('削除しますか?', `「${document.getElementById('ded-name').value}」のシナリオが消えます。`, '削除する', doIt);
  }
}

function closeDateEditor() {
  document.getElementById('date-editor').classList.add('hidden');
  dateEdId = null;
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
  const spot = effectiveDateSpots().find(s => s.id === spotId);
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
  const personality = effectivePersonality();

  const speakerEl = document.getElementById('vn-speaker');
  const textEl    = document.getElementById('vn-text');

  // カスタム台本は beat.text (共通文字列)、標準は beat.lines (性格別 or 共通)
  const rawFor = (b) => {
    if (typeof b.text === 'string') return b.text;
    if (typeof b.lines === 'string') return b.lines;
    return (b.lines && b.lines[personality]) || '';
  };

  if (beat.speaker === 'narration') {
    if (speakerEl) speakerEl.textContent = '';
    const formatted = (typeof Dialogue !== 'undefined') ? Dialogue.format(rawFor(beat), state) : rawFor(beat);
    if (textEl) textEl.textContent = formatted;
    renderChara('vn-chara', 'normal');
  } else {
    if (speakerEl) speakerEl.textContent = state.character.name;
    const formatted = (typeof Dialogue !== 'undefined') ? Dialogue.format(rawFor(beat), state) : rawFor(beat);
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
  const wasPreview = !!vnState.preview;

  if (wasPreview) {
    // 試し再生: 報酬も記録もなし、エディタへ戻る
    vnState = null;
    document.getElementById('screen-date-vn').classList.add('hidden');
    document.getElementById('screen-main').classList.remove('hidden');
    switchTab('date');
    if (_dateEdReturnDraft) {
      openDateEditorWithDraft(_dateEdReturnDraft);
      _dateEdReturnDraft = null;
    }
    return;
  }

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

// ─── キャラクターロスター (複数キャラの保存・交代) ──────────────
// アクティブキャラは state.character / affection / memories に展開し、
// 控えは state.roster に {id, character, affection, memories} で保存する。
const ROSTER_MAX = 6; // アクティブ含む上限 (customArt の容量を考慮)

/** いまのアクティブキャラのスナップショット */
function snapshotActiveChar() {
  return {
    id: state.character.rosterId || uid(),
    character: JSON.parse(JSON.stringify(state.character)),
    affection: state.affection,
    memories: state.memories
  };
}

/** ロスターエントリをアクティブに展開 */
function activateCharEntry(entry) {
  state.character = JSON.parse(JSON.stringify(entry.character));
  state.character.rosterId = entry.id;
  state.affection = entry.affection || 0;
  state.memories = Array.isArray(entry.memories) ? entry.memories : [];
}

/** キャラのサムネイル HTML (立ち絵を小さく描画) */
function charThumbHTML(character) {
  const art = character.customArt;
  if (art && art.dataUrl) return `<img class="custom-art-img" src="${art.dataUrl}" alt="">`;
  if (art && art.base) return art.base;
  if (typeof CharacterArt !== 'undefined') return CharacterArt.render(character.look, 'smile');
  return '🧑';
}

/** せっていのキャラ一覧を描画 */
function renderRosterList() {
  const container = document.getElementById('roster-list');
  if (!container) return;
  const entries = [snapshotActiveChar(), ...state.roster];
  container.innerHTML = entries.map((e, i) => {
    const lv = (typeof GameData !== 'undefined') ? GameData.levelFor(e.affection || 0) : { name: '' };
    const active = i === 0;
    return `<div class="roster-row${active ? ' active' : ''}" data-id="${esc(e.id)}">
      <div class="roster-thumb">${charThumbHTML(e.character)}</div>
      <div class="roster-info">
        <div class="roster-name">${esc(e.character.name)}${active ? '<span class="roster-badge">いっしょ</span>' : ''}</div>
        <div class="roster-meta">💛${esc(lv.name)} · 親密度${e.affection || 0}</div>
      </div>
      ${active ? '' : `<button class="roster-switch-btn" data-id="${esc(e.id)}">交代</button>
      <button class="roster-del-btn" data-id="${esc(e.id)}" aria-label="お別れ">🗑️</button>`}
    </div>`;
  }).join('');

  container.querySelectorAll('.roster-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => switchToCharacter(btn.dataset.id));
  });
  container.querySelectorAll('.roster-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = state.roster.find(e => e.id === btn.dataset.id);
      if (!entry) return;
      showConfirm('お別れしますか?',
        `${entry.character.name}とその思い出(親密度${entry.affection || 0})が消えます。この操作は取り消せません。`,
        'お別れする', () => deleteRosterCharacter(btn.dataset.id));
    });
  });
}

function switchToCharacter(id) {
  const idx = state.roster.findIndex(e => e.id === id);
  if (idx === -1) return;
  const entry = state.roster[idx];
  // いまの子を控えに、選んだ子をアクティブに
  state.roster.splice(idx, 1);
  state.roster.unshift(snapshotActiveChar());
  activateCharEntry(entry);
  saveState();

  renderChara('home-chara', 'smile');
  initSettingsTab();
  refreshStatusBar();
  showToast(`💞 ${state.character.name}と交代しました`);
  // 久しぶり感のある挨拶 (親密度 0 なら初対面の挨拶)
  const speech = getSpeech(state.affection === 0 ? 'setup_first' : 'comeback');
  showBubble(speech);
  switchTab('home');
}

function deleteRosterCharacter(id) {
  state.roster = state.roster.filter(e => e.id !== id);
  saveState();
  renderRosterList();
  showToast('さよなら…');
}

/** 「あたらしい子をつくる」: いまの子は finishSetup 時に控えへ */
let wizardMode = 'initial'; // 'initial' | 'add'

function startAddCharacter() {
  if (1 + state.roster.length >= ROSTER_MAX) {
    showToast(`キャラは${ROSTER_MAX}人まで。誰かとお別れしてから迎えてください`);
    return;
  }
  wizardMode = 'add';
  wizardCustom = null;
  initWizard();
  goToStep(1);
  // プレイヤー名を引き継いでおく
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('s-playerName', state.player.name);
  setVal('s-callName', state.character.callName);
  setVal('s-charName', '');
  setVal('s-firstPerson', '');
  setVal('s-suffix', '');
  const cancelBtn = document.getElementById('wizard-cancel-btn');
  if (cancelBtn) cancelBtn.classList.remove('hidden');
  document.getElementById('screen-main').classList.add('hidden');
  document.getElementById('screen-setup').classList.remove('hidden');
}

function cancelAddCharacter() {
  wizardMode = 'initial';
  wizardCustom = null;
  const cancelBtn = document.getElementById('wizard-cancel-btn');
  if (cancelBtn) cancelBtn.classList.add('hidden');
  document.getElementById('screen-setup').classList.add('hidden');
  document.getElementById('screen-main').classList.remove('hidden');
  switchTab('settings');
}

// ─── 時間帯エディタ (せってい) ──────────────────────────────────
function renderTimeSlotList() {
  const el = document.getElementById('timeslot-list');
  if (!el) return;
  const slots = state.timeSlots;
  el.innerHTML = slots.map(t => `<div class="timeslot-row" data-id="${esc(t.id)}">
    <select class="ts-start" aria-label="開始時刻">
      ${Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}"${h === t.start ? ' selected' : ''}>${h}時〜</option>`).join('')}
    </select>
    <input type="text" class="ts-name" maxlength="8" value="${esc(t.name)}" aria-label="名前">
    <div class="ts-bases">
      ${TIME_BASES.map(b =>
        `<button class="ts-base${b.id === t.base ? ' active' : ''}" data-base="${b.id}">${b.name}</button>`).join('')}
    </div>
    <button class="ts-del" aria-label="削除"${slots.length <= 1 ? ' disabled' : ''}>🗑️</button>
  </div>`).join('');

  const commit = () => {
    saveState();
    renderTimeSlotList();
    // ホームの背景・挨拶に即反映
    if (currentTab === 'home') renderHome(false);
  };
  el.querySelectorAll('.timeslot-row').forEach(row => {
    const slot = state.timeSlots.find(t => t.id === row.dataset.id);
    if (!slot) return;
    row.querySelector('.ts-start').addEventListener('change', e => {
      slot.start = parseInt(e.target.value, 10) || 0;
      state.timeSlots.sort((a, b) => a.start - b.start);
      commit();
    });
    row.querySelector('.ts-name').addEventListener('change', e => {
      slot.name = e.target.value.trim().slice(0, 8) || '時間帯';
      commit();
    });
    row.querySelectorAll('.ts-base').forEach(btn => {
      btn.addEventListener('click', () => {
        slot.base = btn.dataset.base;
        commit();
      });
    });
    row.querySelector('.ts-del').addEventListener('click', () => {
      if (state.timeSlots.length <= 1) return;
      state.timeSlots = state.timeSlots.filter(t => t.id !== slot.id);
      commit();
    });
  });
}

function addTimeSlot() {
  if (state.timeSlots.length >= TIMESLOT_MAX) {
    showToast(`時間帯は${TIMESLOT_MAX}つまでです`);
    return;
  }
  state.timeSlots.push({ id: 'ts-' + uid(), start: 0, name: 'しんや', base: 'night' });
  state.timeSlots.sort((a, b) => a.start - b.start);
  saveState();
  renderTimeSlotList();
}

function resetTimeSlots() {
  state.timeSlots = JSON.parse(JSON.stringify(DEFAULT_STATE.timeSlots));
  saveState();
  renderTimeSlotList();
  showToast('時間帯を標準に戻しました');
}

// ─── せってい ────────────────────────────────────────────────
function initSettingsTab() {
  renderRosterList();
  renderTimeSlotList();
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

  // 服装
  buildChipGroup('settings-outfit-select', CharacterArt ? CharacterArt.OUTFIT_STYLES : [], ch.look.outfitStyle, v => {
    state.character.look.outfitStyle = v;
    renderSettingsPreview();
  });

  // 画像立ち絵の「パーツ編集に戻す」ボタン表示
  const artRevert = document.getElementById('settings-art-revert-btn');
  if (artRevert) artRevert.classList.toggle('hidden', !(ch.customArt && (ch.customArt.base || ch.customArt.dataUrl)));

  // 表情差分マネージャ
  renderExprGrid();

  // 性格 (フルカスタムをインポート済みならそのカードも出す)
  buildPersonalityGrid('settings-personality-grid', ch.personality, v => {
    state.character.personality = v;
  }, ch.customDialogue ? (ch.customLabel || 'カスタム') : null);

}

function renderSettingsPreview() {
  // パーツを操作したときはパラメトリック表示で確認できるようにする
  // (カスタム立ち絵を使用中でも、ここのプレビューだけはパーツ側を見せる)
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

// ─── 画像から立ち絵を作る ───────────────────────────────────────
let artUploadContext = 'settings'; // 'settings' | 'setup'

/** 画像ファイル → リサイズ済み dataURL (PNG、重ければ JPEG) */
function processArtFile(file, cb) {
  if (!file || !/^image\//.test(file.type)) {
    showToast('画像ファイルを選んでください');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const MAXW = 400;
      const MAXH = 520;
      const scale = Math.min(1, MAXW / img.width, MAXH / img.height);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      let dataUrl = canvas.toDataURL('image/png');
      if (dataUrl.length > 600000) dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      if (dataUrl.length > 900000 || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+\/=]+$/.test(dataUrl)) {
        showToast('この画像は使えませんでした (大きすぎます)');
        return;
      }
      cb(dataUrl);
    };
    img.onerror = () => showToast('画像を読み込めませんでした');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function openArtPicker(context) {
  artUploadContext = context;
  const artInput = document.getElementById('art-file-input');
  if (artInput) {
    artInput.value = '';
    artInput.click();
  }
}

function handleArtFileSelected(file) {
  processArtFile(file, dataUrl => {
    if (artUploadContext === 'setup') {
      wizardCustom = Object.assign({}, wizardCustom, { customArt: { dataUrl } });
      renderWizardPreview();
      showToast('📷 立ち絵を設定しました');
      return;
    }
    if (artUploadContext.indexOf('expr:') === 0) {
      // 表情差分 (or きほん差し替え)
      const ex = artUploadContext.slice(5);
      const art = state.character.customArt || {};
      if (ex === 'base') {
        art.dataUrl = dataUrl;
        delete art.base; // SVG きほんを画像に差し替えた場合
      } else {
        art.expressions = art.expressions || {};
        art.expressions[ex] = dataUrl;
      }
      state.character.customArt = art;
      saveState();
      renderChara('home-chara', ex === 'base' ? 'smile' : ex);
      renderExprGrid();
      showToast(`📷 ${ex === 'base' ? 'きほん' : (EXPR_LABELS[ex] || ex)}の立ち絵を設定しました`);
      return;
    }
    state.character.customArt = { dataUrl };
    saveState();
    renderChara('home-chara', 'smile');
    initSettingsTab();
    showBubble('イメチェン、どうかな?');
    showToast('📷 立ち絵を設定しました');
  });
}

// ─── 表情差分マネージャ (画像/SVG 立ち絵の表情登録) ──────────────
const EXPR_LABELS = {
  normal: 'きほん', smile: 'にっこり', joy: 'よろこび', blush: 'てれ',
  pout: 'ぷんすか', sad: 'しょんぼり', surprised: 'びっくり', sleepy: 'おねむ'
};
const EXPR_SLOTS = ['smile', 'joy', 'blush', 'pout', 'sad', 'surprised', 'sleepy'];

function renderExprGrid() {
  const wrap = document.getElementById('expr-manager');
  const grid = document.getElementById('expr-grid');
  if (!wrap || !grid) return;
  const art = state.character.customArt;
  const has = !!(art && (art.dataUrl || art.base));
  wrap.classList.toggle('hidden', !has);
  if (!has) return;

  let html = `<div class="expr-slot filled" data-ex="base">
    <div class="expr-thumb">${artFragmentHTML(art.dataUrl || art.base)}</div>
    <span class="expr-label">きほん</span>
  </div>`;
  html += EXPR_SLOTS.map(ex => {
    const v = art.expressions && art.expressions[ex];
    return `<div class="expr-slot${v ? ' filled' : ''}" data-ex="${ex}">
      <div class="expr-thumb">${v ? artFragmentHTML(v) : '<span class="expr-plus">＋</span>'}</div>
      <span class="expr-label">${EXPR_LABELS[ex]}</span>
      ${v ? `<button class="expr-del" data-ex="${ex}" aria-label="削除">✕</button>` : ''}
    </div>`;
  }).join('');
  grid.innerHTML = html;

  grid.querySelectorAll('.expr-slot').forEach(slot => {
    slot.addEventListener('click', e => {
      if (e.target.classList.contains('expr-del')) return;
      openArtPicker('expr:' + slot.dataset.ex);
    });
  });
  grid.querySelectorAll('.expr-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const art2 = state.character.customArt;
      if (art2 && art2.expressions) {
        delete art2.expressions[btn.dataset.ex];
        if (!Object.keys(art2.expressions).length) delete art2.expressions;
      }
      saveState();
      renderExprGrid();
      renderChara('home-chara', 'smile');
      showToast('表情を削除しました');
    });
  });
}

/** カスタム立ち絵をやめてパーツ編集に戻す */
function revertCustomArt(context) {
  if (context === 'setup') {
    if (wizardCustom) wizardCustom.customArt = null;
    renderWizardPreview();
  } else {
    state.character.customArt = null;
    saveState();
    renderChara('home-chara', 'smile');
    initSettingsTab();
  }
  showToast('↩️ パーツ編集に戻しました');
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
let wizardCustom = null; // インポートされたフルカスタムデータ (セットアップ中のみ)
let wizardStep = 1;

function initWizard() {
  wizardLook = JSON.parse(JSON.stringify(DEFAULT_STATE.character.look));
  buildWizardControls();

  // ステップドット番号
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.textContent = i + 1;
  });
}

/** 現在の wizardLook / wizardPersonality を UI に反映 (インポート後の再同期にも使う) */
function buildWizardControls() {
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

  // 服装チップ
  buildChipGroup('outfitStyle-select', CharacterArt ? CharacterArt.OUTFIT_STYLES : [], wizardLook.outfitStyle, v => {
    wizardLook.outfitStyle = v;
    renderWizardPreview();
  });

  // カラーピッカー (再実行されるため oninput 代入で多重登録を避ける)
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
    el.oninput = () => {
      wizardLook[key] = el.value;
      renderWizardPreview();
    };
  });

  renderWizardPreview();

  // Step2: 性格 (インポートでフルカスタムが入っていればカードを出す)
  buildPersonalityGrid('personality-grid', wizardPersonality, v => {
    wizardPersonality = v;
  }, wizardCustom ? (wizardCustom.customLabel || 'カスタム') : null);
}

function renderWizardPreview() {
  const el = document.getElementById('setup-chara-preview');
  if (!el) return;
  const art = wizardCustom && wizardCustom.customArt;
  const revertBtn = document.getElementById('wizard-art-revert-btn');
  if (revertBtn) revertBtn.classList.toggle('hidden', !art);
  if (art && (art.base || art.dataUrl)) {
    el.innerHTML = customArtHTML(art, 'smile');
    return;
  }
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
  // 「あたらしい子をつくる」モードならいまの子を控えに退避し、絆をリセット
  if (wizardMode === 'add') {
    state.roster.unshift(snapshotActiveChar());
    state.character = JSON.parse(JSON.stringify(DEFAULT_STATE.character));
    state.affection = 0;
    state.memories = [];
    wizardMode = 'initial';
    const cancelBtn = document.getElementById('wizard-cancel-btn');
    if (cancelBtn) cancelBtn.classList.add('hidden');
  }
  state.character.rosterId = state.character.rosterId || uid();

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
  if (wizardCustom) {
    state.character.customLabel     = wizardCustom.customLabel || null;
    state.character.basePersonality = wizardCustom.basePersonality || null;
    state.character.customDialogue  = wizardCustom.customDialogue || null;
    state.character.customArt       = wizardCustom.customArt || null;
  }
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

function buildPersonalityGrid(containerId, activeValue, onSelect, customLabel) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const personalities = ['tsundere', 'cool', 'caring', 'genki', 'sweet'];
  const customCard = customLabel ? `<button class="personality-card${activeValue === 'custom' ? ' active' : ''}" data-value="custom">
      <div class="personality-name">💎 ${esc(customLabel)}</div>
      <div class="personality-desc">チャットで作ったフルカスタム性格</div>
      <div class="personality-sample">インポート済みのセリフ集を使います</div>
    </button>` : '';
  container.innerHTML = customCard + personalities.map(p =>
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

// ─── セリフエディタ (アプリ内でカスタムセリフを編集) ──────────────
// 書いた場面だけ customDialogue に保存され、Dialogue エンジンが標準セリフより
// 優先して使う (プリセット性格への部分上書きにも、フルカスタムの修正にも対応)。
const DIALOGUE_EDIT_META = [
  { id: 'setup_first',      label: 'はじめましての挨拶' },
  { id: 'greeting_morning', label: 'あさの挨拶 (5〜10時)' },
  { id: 'greeting_day',     label: 'ひるの挨拶 (10〜17時)' },
  { id: 'greeting_evening', label: 'ゆうがたの挨拶 (17〜22時)' },
  { id: 'greeting_night',   label: 'よるの挨拶 (22〜5時)' },
  { id: 'idle',             label: '立ち絵をタップしたとき' },
  { id: 'task_add',         label: 'タスクを追加したとき', ph: '{task}' },
  { id: 'task_complete',    label: 'タスクを完了したとき', ph: '{task}' },
  { id: 'all_done',         label: '今日ぜんぶ完了したとき' },
  { id: 'has_overdue',      label: '夕方にタスクが残っているとき' },
  { id: 'comeback',         label: 'ひさしぶりに会えたとき' },
  { id: 'levelup',          label: '親密度が上がったとき' },
  { id: 'gift_reaction',    label: 'プレゼントをもらったとき', ph: '{gift}' },
  { id: 'praise:int',       label: '知性📚を褒めるとき' },
  { id: 'praise:fit',       label: '体力💪を褒めるとき' },
  { id: 'praise:life',      label: '生活力🏠を褒めるとき' },
  { id: 'praise:sense',     label: '感性🎨を褒めるとき' },
  { id: 'praise:grit',      label: '根性🔥を褒めるとき' }
];

/** 編集できる場面の一覧 (固定 18 + プレゼント別 + カスタム時間帯) */
function getDialogueEditMeta() {
  const meta = DIALOGUE_EDIT_META.slice();
  if (typeof GameData !== 'undefined') {
    GameData.GIFTS.forEach(g => {
      meta.push({ id: 'gift:' + g.id, label: `プレゼント: ${g.icon}${g.name}` });
    });
  }
  (state.timeSlots || []).forEach(t => {
    meta.push({ id: 'slot:' + t.id, label: `「${t.name}」の挨拶 (${t.start}時〜)` });
  });
  return meta;
}

let deCurrentSit = null;

/** その場面のカスタムセリフを平坦な配列で返す (なければ null) */
function deGetPool(sitId) {
  const cd = state.character.customDialogue;
  if (!cd) return null;
  let entry;
  if (sitId.startsWith('praise:')) entry = cd.praise && cd.praise[sitId.slice(7)];
  else if (sitId.startsWith('gift:')) entry = cd.gifts && cd.gifts[sitId.slice(5)];
  else entry = cd[sitId];
  if (!entry) return null;
  if (Array.isArray(entry)) return entry.slice();
  // tier 別 {low,mid,high} は編集用に平坦化
  return ['low', 'mid', 'high'].reduce((acc, t) =>
    acc.concat(Array.isArray(entry[t]) ? entry[t] : []), []);
}

/** カスタムセリフを保存 (null/空で標準に戻す) */
function deSetPool(sitId, lines) {
  if (!state.character.customDialogue) state.character.customDialogue = {};
  const cd = state.character.customDialogue;
  const value = (lines && lines.length) ? lines : null;
  if (sitId.startsWith('praise:')) {
    const pid = sitId.slice(7);
    if (value) {
      cd.praise = cd.praise || {};
      cd.praise[pid] = value;
    } else if (cd.praise) {
      delete cd.praise[pid];
      if (!Object.keys(cd.praise).length) delete cd.praise;
    }
  } else if (sitId.startsWith('gift:')) {
    const gid = sitId.slice(5);
    if (value) {
      cd.gifts = cd.gifts || {};
      cd.gifts[gid] = value;
    } else if (cd.gifts) {
      delete cd.gifts[gid];
      if (!Object.keys(cd.gifts).length) delete cd.gifts;
    }
  } else if (value) {
    cd[sitId] = value;
  } else {
    delete cd[sitId];
  }
  if (!Object.keys(cd).length) state.character.customDialogue = null;
  saveState();
}

/** 標準 (ベース性格) のセリフ。コピー元・プレビュー用 */
function dePresetLines(sitId) {
  if (typeof Dialogue === 'undefined') return [];
  const p = Dialogue.resolvePersonality(state);
  if (sitId.startsWith('praise:')) {
    const d = Dialogue.PARAM_PRAISE[p] || {};
    return (d[sitId.slice(7)] || []).slice();
  }
  if (sitId.startsWith('gift:')) {
    const g = (typeof GameData !== 'undefined') && GameData.GIFTS.find(x => x.id === sitId.slice(5));
    return (g && g.reactions && g.reactions[p]) ? g.reactions[p].slice() : [];
  }
  if (sitId.startsWith('slot:')) {
    const slot = (state.timeSlots || []).find(t => 'slot:' + t.id === sitId);
    const sd2 = slot && (Dialogue.DIALOGUE[p] || {})['greeting_' + slot.base];
    if (!sd2) return [];
    return ['low', 'mid', 'high'].reduce((acc, t) => acc.concat(sd2[t] || []), []);
  }
  if (sitId === 'gift_reaction') return []; // 汎用は {gift} 込みで書く想定なのでコピー元なし
  const sd = (Dialogue.DIALOGUE[p] || {})[sitId];
  if (!sd) return [];
  return ['low', 'mid', 'high'].reduce((acc, t) => acc.concat(sd[t] || []), []);
}

function openDialogueEditor() {
  deRenderList();
  document.getElementById('de-list').classList.remove('hidden');
  document.getElementById('de-list-footer').classList.remove('hidden');
  document.getElementById('de-detail').classList.add('hidden');
  document.getElementById('de-title').textContent = `${state.character.name}のセリフ`;
  document.getElementById('dialogue-editor').classList.remove('hidden');
}

function closeDialogueEditor() {
  document.getElementById('dialogue-editor').classList.add('hidden');
  deCurrentSit = null;
}

function deRenderList() {
  const el = document.getElementById('de-list');
  el.innerHTML = getDialogueEditMeta().map(m => {
    const pool = deGetPool(m.id);
    const status = pool ? `カスタム ${pool.length}本` : '標準';
    return `<button class="de-row${pool ? ' customized' : ''}" data-sit="${esc(m.id)}">
      <span class="de-row-label">${esc(m.label)}</span>
      <span class="de-row-status">${esc(status)} ›</span>
    </button>`;
  }).join('');
  el.querySelectorAll('.de-row').forEach(btn => {
    btn.addEventListener('click', () => deOpenSit(btn.dataset.sit));
  });
}

function deOpenSit(sitId) {
  deCurrentSit = sitId;
  const meta = getDialogueEditMeta().find(m => m.id === sitId);
  document.getElementById('de-title').textContent = meta.label;
  const hints = ['{user} = 呼び名', '{me} = 一人称'];
  if (meta.ph) hints.push(`${meta.ph} = ${meta.ph === '{task}' ? 'タスク名' : 'プレゼント名'}`);
  if (sitId.startsWith('gift:')) hints.push('このプレゼント専用 (汎用より優先)');
  if (sitId.startsWith('slot:')) hints.push('この時間帯専用の挨拶 (空なら標準の挨拶)');
  document.getElementById('de-hint').textContent =
    '1 枠 = 1 セリフ (最大 10 本)。空にして保存すると標準セリフに戻ります。使えるタグ: ' + hints.join(' / ');
  deRenderLines(deGetPool(sitId) || []);
  document.getElementById('de-preview').textContent = '';
  document.getElementById('de-list').classList.add('hidden');
  document.getElementById('de-list-footer').classList.add('hidden');
  document.getElementById('de-detail').classList.remove('hidden');
}

function deRenderLines(lines) {
  const el = document.getElementById('de-lines');
  if (!lines.length) {
    el.innerHTML = '<p class="de-empty">まだカスタムセリフがありません。「＋」で書くか「標準からコピー」で下敷きを入れられます。</p>';
    return;
  }
  el.innerHTML = lines.map(() =>
    `<div class="de-line-row">
      <textarea class="de-line" rows="2" maxlength="200"></textarea>
      <button class="de-line-del" aria-label="削除">🗑️</button>
    </div>`).join('');
  // 値は textarea の value で安全に注入
  el.querySelectorAll('.de-line').forEach((ta, i) => { ta.value = lines[i]; });
  el.querySelectorAll('.de-line-del').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.de-line-row').remove();
      if (!document.querySelector('#de-lines .de-line-row')) deRenderLines([]);
    });
  });
}

function deCollectLines() {
  return [...document.querySelectorAll('#de-lines .de-line')]
    .map(ta => ta.value.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 10);
}

function deAddLine() {
  const lines = deCollectLines();
  if (lines.length >= 10) {
    showToast('セリフは 10 本までです');
    return;
  }
  lines.push('');
  // 空行は collect で消えるので直接描画
  const el = document.getElementById('de-lines');
  if (el.querySelector('.de-empty')) el.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'de-line-row';
  row.innerHTML = `<textarea class="de-line" rows="2" maxlength="200"></textarea>
    <button class="de-line-del" aria-label="削除">🗑️</button>`;
  row.querySelector('.de-line-del').addEventListener('click', () => {
    row.remove();
    if (!document.querySelector('#de-lines .de-line-row')) deRenderLines([]);
  });
  el.appendChild(row);
  row.querySelector('.de-line').focus();
}

function deCopyPreset() {
  const preset = dePresetLines(deCurrentSit);
  if (!preset.length) {
    showToast('この場面には標準セリフがありません');
    return;
  }
  const current = deCollectLines();
  const merged = [...current];
  preset.forEach(l => {
    if (merged.length < 10 && !merged.includes(l)) merged.push(l);
  });
  deRenderLines(merged);
}

function deTry() {
  const lines = deCollectLines();
  const pool = lines.length ? lines : dePresetLines(deCurrentSit);
  if (!pool.length) return;
  let line = pool[Math.floor(Math.random() * pool.length)];
  line = line.replace(/\{task\}/g, 'さんぽ').replace(/\{gift\}/g, '花束');
  const formatted = (typeof Dialogue !== 'undefined') ? Dialogue.format(line, state) : line;
  document.getElementById('de-preview').textContent = `「${formatted}」`;
}

function deSave() {
  const lines = deCollectLines();
  deSetPool(deCurrentSit, lines);
  showToast(lines.length ? `💾 ${lines.length}本のセリフを保存しました` : '標準セリフに戻しました');
  deBackToList();
}

function deResetSit() {
  deSetPool(deCurrentSit, null);
  showToast('標準セリフに戻しました');
  deBackToList();
}

function deBackToList() {
  deCurrentSit = null;
  const meta = document.getElementById('de-title');
  meta.textContent = `${state.character.name}のセリフ`;
  deRenderList();
  document.getElementById('de-detail').classList.add('hidden');
  document.getElementById('de-list').classList.remove('hidden');
  document.getElementById('de-list-footer').classList.remove('hidden');
}

// ─── 部分インポート (セリフ集 / デート台本を既存キャラに追加) ──────
// キャラ作成後でも、AI チャットに書いてもらったセリフやデート台本だけを
// 取り込める。キャラ本体 (見た目・名前など) は変更しない。
let partialImportMode = 'dialogue'; // 'dialogue' | 'dates'
let partialImportPayload = null;    // 検証済みの適用待ちデータ

/** いまの子のプロフィール説明 (相談プロンプトに埋め込む) */
function charProfileForPrompt() {
  const ch = state.character;
  const lines = [];
  lines.push(`- 名前: ${ch.name}`);
  if (ch.personality === 'custom') {
    lines.push(`- 性格: ${ch.customLabel || 'カスタム'}(ベース: ${PERSONALITY_NAMES[ch.basePersonality] || 'クール'})`);
  } else {
    lines.push(`- 性格: ${PERSONALITY_NAMES[ch.personality]}(${PERSONALITY_DESCS[ch.personality] || ''})`);
  }
  lines.push(`- 一人称: ${ch.firstPerson} / わたしの呼び方: ${ch.callName}`);
  if (ch.suffix) lines.push(`- 語尾: 「${ch.suffix}」(アプリ側で自動付与するのでセリフには書かない)`);
  // 声のサンプル (カスタムセリフがあれば優先)
  const samples = [];
  const cd = ch.customDialogue;
  if (cd) {
    const firstLine = (pool) => {
      const arr = Array.isArray(pool) ? pool : (pool && (pool.low || pool.mid || pool.high));
      return arr && arr[0];
    };
    // よく書かれている場面を優先しつつ、何でもいいので最大 3 本拾う
    const sits = ['idle', 'task_complete', 'setup_first']
      .concat(Object.keys(cd).filter(k => k !== 'praise'));
    sits.forEach(sit => {
      const line = firstLine(cd[sit]);
      if (line && samples.length < 3 && !samples.includes(line)) samples.push(line);
    });
  }
  if (!samples.length && typeof Dialogue !== 'undefined') {
    const p = Dialogue.resolvePersonality(state);
    const idle = (Dialogue.DIALOGUE[p] || {}).idle;
    if (idle && idle.low) samples.push(idle.low[0]);
  }
  if (samples.length) {
    lines.push('- 話し方のサンプル:');
    samples.forEach(l => lines.push(`  「${l}」`));
  }
  return lines.join('\n');
}

/** セリフ集の相談プロンプト */
function buildDialoguePrompt() {
  return `あなたはシナリオライターです。わたしのタスク管理アプリ「いっしょぐらし」に住んでいるキャラクターの追加セリフを書いてください。

キャラのプロフィール:
${charProfileForPrompt()}

書いてほしい場面を相談して決めたら、最後に次の形式の JSON をコードブロックで 1 つだけ出力してください。書いた場面だけが上書きされ、他はそのまま残ります。

{
  "dialogue": {
    "idle": ["セリフ1", "セリフ2", "…(2〜5本)"],
    "task_complete": { "low": ["…"], "mid": ["…"], "high": ["…"] }
  }
}

場面名 (好きなものだけで OK):
- greeting_morning / greeting_day / greeting_evening / greeting_night … 時間帯の挨拶
- task_add({task} 可) / task_complete({task} 可) / all_done
- idle … 立ち絵タップの雑談 (多めに 5 本ほしい)
- has_overdue / comeback / levelup / setup_first
- gift_reaction … プレゼント全般への反応 ({gift} 可)
- gifts … プレゼント別の反応: {"flower":[…],"sweets":[…]} など (id: ${(typeof GameData !== 'undefined' ? GameData.GIFTS : []).map(g => `${g.id}=${g.name}`).join(' / ')})
- praise … {"int":[…],"fit":[…],"life":[…],"sense":[…],"grit":[…]} (知性/体力/生活力/感性/根性を褒める)${(state.timeSlots || []).length ? `
- 時間帯専用の挨拶: ${state.timeSlots.map(t => `"slot:${t.id}"(「${t.name}」${t.start}時〜)`).join(' / ')}` : ''}

ルール:
- 文字列配列なら親密度に関係なく使われる。{"low":[…],"mid":[…],"high":[…]} なら親密度段階別 (low=出会った頃 / high=心を許した仲)
- {user} はわたしの呼び名、{me} はキャラの一人称に置き換わる
- 1 本 200 文字以内・1 場面 10 本まで`;
}

/** デート台本の相談プロンプト */
function buildDatesPrompt() {
  const bgs = DATE_BG_OPTIONS.map(b => `${b.id}(${b.name})`).join(' / ');
  return `あなたはシナリオライターです。わたしのタスク管理アプリ「いっしょぐらし」の、キャラクターとのおでかけ(デート)シーンの台本を書いてください。

キャラのプロフィール:
${charProfileForPrompt()}

行き先を相談して決めたら、最後に次の形式の JSON をコードブロックで 1 つだけ出力してください (1〜3 件)。

{
  "dates": [
    {
      "name": "星空の丘",
      "icon": "🌌",
      "price": 200,
      "minLevel": 2,
      "affection": 30,
      "bgClass": "vn-cinema",
      "script": [
        { "speaker": "narration", "text": "ふたりは丘の上にやってきた。" },
        { "speaker": "char", "text": "わぁ…星がきれいだね、{user}。" }
      ]
    }
  ]
}

ルール:
- script は 4〜12 コマ。speaker は "char"(キャラのセリフ) か "narration"(地の文)。1 コマ 300 文字以内
- {user} はわたしの呼び名、{me} はキャラの一人称に置き換わる
- bgClass は背景: ${bgs}
- name 12 文字以内 / icon は絵文字 1 つ / price 0〜9999 / affection (ごほうび親密度) 0〜100 / minLevel 1〜6
- 標準スポットを置き換えたいときだけ "id" を付ける: cafe(カフェ) / movie(映画館) / aquarium(水族館) / amusement(遊園地) / onsen(温泉旅行)`;
}

/** デート台本インポートの検証。{ ok, dates } or { ok:false, error } */
function validateDateImport(obj) {
  let list = obj && obj.dates ? obj.dates : obj;
  if (list && !Array.isArray(list) && typeof list === 'object' && list.script) list = [list];
  if (!Array.isArray(list) || !list.length) {
    return { ok: false, error: 'dates (おでかけ先の配列) が見つかりません' };
  }
  if (list.length > 5) return { ok: false, error: '一度にインポートできるのは 5 件までです' };
  const bgIds = DATE_BG_OPTIONS.map(b => b.id);
  const builtinIds = (typeof GameData !== 'undefined') ? GameData.DATE_SPOTS.map(b => b.id) : [];
  const errors = [];
  const dates = [];
  list.forEach((d, i) => {
    const tag = `dates[${i}]`;
    const name = String(d.name || '').trim().slice(0, 12);
    if (!name) { errors.push(`${tag}: name がありません`); return; }
    const beats = Array.isArray(d.script) ? d.script
      .map(b => ({
        speaker: b.speaker === 'narration' ? 'narration' : 'char',
        text: String(b.text || (typeof b.lines === 'string' ? b.lines : '') || '').trim().slice(0, 300)
      }))
      .filter(b => b.text)
      .slice(0, 12) : [];
    if (!beats.length) { errors.push(`${tag}: script (台本) がありません`); return; }
    let id = String(d.id || '').trim();
    if (id && !builtinIds.includes(id) && !state.customDates.some(c => c.id === id)) {
      id = ''; // 不明な id は新規扱い
    }
    const spot = {
      id: id || ('cd-' + uid()),
      name,
      icon: String(d.icon || '🌟').trim().slice(0, 4) || '🌟',
      price: Math.max(0, Math.min(9999, parseInt(d.price, 10) || 0)),
      affection: Math.max(0, Math.min(100, parseInt(d.affection, 10) || 0)),
      minLevel: Math.max(1, Math.min(6, parseInt(d.minLevel, 10) || 1)),
      bgClass: bgIds.includes(d.bgClass) ? d.bgClass : 'vn-cafe',
      script: beats
    };
    const builtin = (typeof GameData !== 'undefined') && GameData.DATE_SPOTS.find(b => b.id === spot.id);
    if (builtin && builtin.statReq) spot.statReq = builtin.statReq;
    dates.push(spot);
  });
  if (errors.length) return { ok: false, error: errors.join('\n') };
  return { ok: true, dates };
}

function openPartialImport(mode) {
  partialImportMode = mode;
  partialImportPayload = null;
  const modal = document.getElementById('partial-import-modal');
  document.getElementById('pi-title').textContent =
    mode === 'dialogue' ? 'セリフをインポート' : 'デート台本をインポート';
  document.getElementById('pi-desc').textContent = mode === 'dialogue'
    ? 'AIチャットが出力した {"dialogue": {…}} 形式の JSON を貼り付けてください。書いてある場面だけ上書きされます。'
    : 'AIチャットが出力した {"dates": […]} 形式の JSON を貼り付けてください。';
  document.getElementById('pi-text').value = '';
  document.getElementById('pi-error').classList.add('hidden');
  document.getElementById('pi-summary').classList.add('hidden');
  document.getElementById('pi-apply').disabled = true;
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('pi-text').focus(), 100);
}

function refreshPartialImport() {
  const text = document.getElementById('pi-text').value;
  const errEl = document.getElementById('pi-error');
  const sumEl = document.getElementById('pi-summary');
  const applyBtn = document.getElementById('pi-apply');
  partialImportPayload = null;
  applyBtn.disabled = true;
  errEl.classList.add('hidden');
  sumEl.classList.add('hidden');
  if (!text.trim()) return;

  let obj;
  try {
    obj = parseCharacterJSON(text); // コードフェンス・スマート引用符に寛容なパーサを共用
  } catch (e) {
    errEl.textContent = 'JSON を読み取れませんでした。コードブロックごと貼り付けても大丈夫です。';
    errEl.classList.remove('hidden');
    return;
  }

  if (partialImportMode === 'dialogue') {
    const pack = obj.dialogue || obj;
    const res = validateCustomDialogue(pack);
    if (!res.ok) {
      errEl.textContent = res.error;
      errEl.classList.remove('hidden');
      return;
    }
    partialImportPayload = res.dialogue;
    const meta = getDialogueEditMeta();
    const labelFor = (id) => {
      const m = meta.find(x => x.id === id);
      return m ? m.label : id;
    };
    const labels = Object.keys(res.dialogue)
      .filter(k => k !== 'praise' && k !== 'gifts')
      .map(labelFor);
    if (res.dialogue.praise) {
      Object.keys(res.dialogue.praise).forEach(pid => labels.push(labelFor('praise:' + pid)));
    }
    if (res.dialogue.gifts) {
      Object.keys(res.dialogue.gifts).forEach(gid => labels.push(labelFor('gift:' + gid)));
    }
    sumEl.textContent = `✅ ${labels.length} 場面のセリフ: ${labels.join(' / ')}`;
  } else {
    const res = validateDateImport(obj);
    if (!res.ok) {
      errEl.textContent = res.error;
      errEl.classList.remove('hidden');
      return;
    }
    partialImportPayload = res.dates;
    sumEl.textContent = '✅ ' + res.dates.map(d =>
      `${d.icon}${d.name}(${d.script.length}コマ・🪙${d.price}・Lv${d.minLevel})`).join(' / ');
  }
  sumEl.classList.remove('hidden');
  applyBtn.disabled = false;
}

function applyPartialImport() {
  if (!partialImportPayload) return;
  if (partialImportMode === 'dialogue') {
    const cd = state.character.customDialogue || {};
    const incoming = partialImportPayload;
    // praise / gifts はサブキー単位でマージ、それ以外は場面単位で上書き
    const mergedPraise = Object.assign({}, cd.praise, incoming.praise);
    const mergedGifts = Object.assign({}, cd.gifts, incoming.gifts);
    state.character.customDialogue = Object.assign({}, cd, incoming);
    if (Object.keys(mergedPraise).length) state.character.customDialogue.praise = mergedPraise;
    if (Object.keys(mergedGifts).length) state.character.customDialogue.gifts = mergedGifts;
    saveState();
    showToast('💾 セリフを取り込みました');
    if (!document.getElementById('dialogue-editor').classList.contains('hidden')) deRenderList();
  } else {
    let added = 0;
    for (const spot of partialImportPayload) {
      const idx = state.customDates.findIndex(c => c.id === spot.id);
      if (idx >= 0) {
        state.customDates[idx] = spot;
      } else if (state.customDates.length >= DATE_CUSTOM_MAX) {
        showToast(`カスタムは${DATE_CUSTOM_MAX}件まで。一部を取り込めませんでした`);
        break;
      } else {
        state.customDates.push(spot);
      }
      added++;
    }
    saveState();
    renderDateSpots();
    showToast(`💾 ${added}件のおでかけ先を取り込みました`);
  }
  document.getElementById('partial-import-modal').classList.add('hidden');
  partialImportPayload = null;
}

// ─── キャラクターインポート (チャットで相談 → JSON 取り込み) ──────
// AI チャットに相談用プロンプトを貼ってキャラを作り、出力された JSON を
// インポートする。FocusFlow のクリップボードインポートと同じ思想。
let importContext = 'settings'; // 'settings' | 'setup'
let importedCharacter = null;   // 検証済みのインポート候補

/** AI チャットに貼る相談用プロンプト (選択肢はデータから動的生成) */
function buildCharPrompt() {
  const hairs = (typeof CharacterArt !== 'undefined' ? CharacterArt.HAIR_STYLES : [])
    .map(h => `${h.id}(${h.name})`).join(' / ');
  const accs = (typeof CharacterArt !== 'undefined' ? CharacterArt.ACCESSORIES : [])
    .map(a => `${a.id}(${a.name})`).join(' / ');
  const outfits = (typeof CharacterArt !== 'undefined' ? CharacterArt.OUTFIT_STYLES : [])
    .map(o => `${o.id}(${o.name})`).join(' / ');
  const pers = Object.keys(PERSONALITY_NAMES)
    .map(p => `${p}(${PERSONALITY_NAMES[p]}: ${PERSONALITY_DESCS[p]})`).join('\n  - ');
  const exprs = (typeof CharacterArt !== 'undefined' ? CharacterArt.EXPRESSIONS : []).join(' / ');

  return `あなたはキャラクターデザイナー兼シナリオライターです。わたしのタスク管理アプリ「いっしょぐらし」に住んでくれるキャラクターを、会話で相談しながら一緒に作ってください。見た目・性格・話し方の希望を聞いて、提案してください。

キャラが決まったら、最後に次の形式の JSON をコードブロックで 1 つだけ出力してください。

{
  "name": "キャラの名前(12文字以内)",
  "personality": "tsundere",
  "firstPerson": "一人称(8文字以内)",
  "callName": "キャラがわたしを呼ぶ名前(12文字以内)",
  "suffix": "語尾(例「にゃ」4文字以内。不要なら空)",
  "look": { "hairStyle": "long", "hairColor": "#6b4f3a", "eyeColor": "#4a6fa5", "skinTone": "#ffe3cf", "outfitColor": "#e8718d", "outfitStyle": "dress", "accessory": "none" }
}

== 性格 ==
かんたんに済ませるなら personality を次のプリセットから選びます:
  - ${pers}

**フルカスタム性格** にする場合は、personality の代わりに次を入れてください:
- "personality": "custom"、"personalityLabel": "性格の名前(16文字以内)"
- "basePersonality": プリセットのどれか(書いていない場面とデートシーンで使う代役)
- "dialogue": 下の場面ごとのセリフ集。各場面は文字列の配列(2〜5本)、または親密度段階別の {"low":[…],"mid":[…],"high":[…]}(low=出会った頃/mid=仲良し/high=心を許した関係)

dialogue の場面一覧:
- greeting_morning / greeting_day / greeting_evening / greeting_night … 時間帯の挨拶
- task_add … タスク追加時({task} でタスク名が入る)
- task_complete … タスク完了時({task} 可)
- all_done … その日の全タスク完了
- idle … 立ち絵をタップしたときの雑談(多めに 5 本ほしい)
- has_overdue … 夕方以降にタスクが残っているとき
- comeback … 数日ぶりに会えたとき
- levelup … 親密度が上がったとき
- setup_first … 初対面の挨拶
- gift_reaction … プレゼントをもらったとき({gift} でプレゼント名が入る)
- praise … 自分磨きを褒める。{"int":[…],"fit":[…],"life":[…],"sense":[…],"grit":[…]}(知性/体力/生活力/感性/根性)

セリフの中で {user} はわたしの呼び名、{me} はキャラの一人称に置き換わります。全場面を書くのが理想ですが、書いた分だけ使われます(残りは basePersonality の標準セリフ)。

== 見た目 ==
かんたんに済ませるなら look でパーツを選びます:
- hairStyle: ${hairs}
- accessory: ${accs}
- outfitStyle: ${outfits}
- 色は #rrggbb 形式

**フルカスタム立ち絵** にする場合は look の代わりに(または look も残したまま)次を入れてください:
- "svg": "<svg viewBox=\\"0 0 200 260\\">…</svg>" … 立ち絵の SVG。全身のデフォルメキャラ(2.5頭身くらい)、中央配置、足元が y=250 付近。path/circle/ellipse/rect/polygon と linearGradient だけで描く(script・image・外部参照は使えません)
- "svgExpressions": { "joy": "<svg…>", "sad": "<svg…>" } … 任意の表情差分(${exprs} のうち好きなもの。無い表情は基本の svg を使う)

JSON は必ず正しい構文で、1 つのコードブロックにまとめてください。`;
}

/** チャット出力の揺れを吸収して JSON を取り出す */
function parseCharacterJSON(text) {
  let t = String(text || '')
    // スマート引用符の正規化 (アプリ版チャット対策)
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\uFF07]/g, "'");
  // コードフェンスや前後の文章を除いて最初の { から最後の } までを抜き出す
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('JSON が見つかりません');
  return JSON.parse(t.slice(start, end + 1));
}

const DIALOGUE_SITUATIONS = [
  'greeting_morning', 'greeting_day', 'greeting_evening', 'greeting_night',
  'task_add', 'task_complete', 'all_done', 'idle', 'has_overdue',
  'comeback', 'levelup', 'setup_first'
];

/** カスタムセリフ集の検証・正規化。{ ok, dialogue } or { ok:false, error } */
function validateCustomDialogue(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'dialogue がありません' };
  const cleanPool = (v) => {
    const arr = Array.isArray(v) ? v : null;
    if (!arr) return null;
    const lines = arr.filter(x => typeof x === 'string' && x.trim())
      .map(x => x.trim().slice(0, 200)).slice(0, 10);
    return lines.length ? lines : null;
  };
  const cleanEntry = (v) => {
    if (Array.isArray(v)) return cleanPool(v);
    if (v && typeof v === 'object') {
      const out = {};
      ['low', 'mid', 'high'].forEach(t => {
        const p = cleanPool(v[t]);
        if (p) out[t] = p;
      });
      return Object.keys(out).length ? out : null;
    }
    return null;
  };

  const dialogue = {};
  let count = 0;
  DIALOGUE_SITUATIONS.forEach(sit => {
    const e = cleanEntry(raw[sit]);
    if (e) { dialogue[sit] = e; count++; }
  });
  // カスタム時間帯の専用挨拶 (現在定義されているスロットのみ)
  (state.timeSlots || []).forEach(t => {
    const e = cleanEntry(raw['slot:' + t.id]);
    if (e) { dialogue['slot:' + t.id] = e; count++; }
  });
  const gift = cleanPool(raw.gift_reaction);
  if (gift) { dialogue.gift_reaction = gift; count++; }
  // プレゼント別の反応
  if (raw.gifts && typeof raw.gifts === 'object' && typeof GameData !== 'undefined') {
    const gifts = {};
    GameData.GIFTS.forEach(g => {
      const p = cleanPool(raw.gifts[g.id]);
      if (p) { gifts[g.id] = p; count++; }
    });
    if (Object.keys(gifts).length) dialogue.gifts = gifts;
  }
  if (raw.praise && typeof raw.praise === 'object') {
    const praise = {};
    ['int', 'fit', 'life', 'sense', 'grit'].forEach(pid => {
      const p = cleanPool(raw.praise[pid]);
      if (p) { praise[pid] = p; count++; }
    });
    if (Object.keys(praise).length) dialogue.praise = praise;
  }
  if (count === 0) {
    return { ok: false, error: 'dialogue に有効なセリフがありません (situation 名と文字列配列を確認してください)' };
  }
  return { ok: true, dialogue, situationCount: count };
}

/** インポート候補を検証して正規化。{ ok, character } or { ok:false, error } */
function validateCharacterImport(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'JSON の形式が正しくありません' };
  const errors = [];

  const name = String(obj.name || '').trim().slice(0, 12);
  if (!name) errors.push('name (キャラの名前) がありません');

  // 性格: プリセット or フルカスタム (dialogue 必須)
  let personality = String(obj.personality || '');
  let customLabel = null;
  let basePersonality = null;
  let customDialogue = null;
  if (!PERSONALITY_NAMES[personality]) {
    if (obj.dialogue) {
      // フルカスタム性格
      customLabel = String(obj.personalityLabel || personality || 'カスタム').trim().slice(0, 16) || 'カスタム';
      personality = 'custom';
      basePersonality = PERSONALITY_NAMES[obj.basePersonality] ? String(obj.basePersonality) : 'cool';
      const dres = validateCustomDialogue(obj.dialogue);
      if (!dres.ok) errors.push(dres.error);
      else customDialogue = dres.dialogue;
    } else {
      errors.push(`personality は ${Object.keys(PERSONALITY_NAMES).join(' / ')} のどれか、またはフルカスタム (dialogue 必須) にしてください`);
    }
  } else if (obj.dialogue) {
    // プリセット指定+セリフ集 → カスタム扱い (プリセットをベースに)
    const dres = validateCustomDialogue(obj.dialogue);
    if (dres.ok) {
      customLabel = String(obj.personalityLabel || PERSONALITY_NAMES[personality] + '改').trim().slice(0, 16);
      basePersonality = personality;
      personality = 'custom';
      customDialogue = dres.dialogue;
    }
  }

  // フルカスタム立ち絵 (SVG)
  let customArt = null;
  if (obj.svg) {
    const base = sanitizeSVG(obj.svg);
    if (!base) {
      errors.push('svg を読み込めませんでした (許可されない要素を含むか、形式が不正です)');
    } else {
      customArt = { base, expressions: {} };
      if (obj.svgExpressions && typeof obj.svgExpressions === 'object') {
        const exIds = (typeof CharacterArt !== 'undefined') ? CharacterArt.EXPRESSIONS : [];
        exIds.forEach(ex => {
          if (obj.svgExpressions[ex]) {
            const clean = sanitizeSVG(obj.svgExpressions[ex]);
            if (clean) customArt.expressions[ex] = clean;
          }
        });
      }
    }
  }

  const look = obj.look || {};
  const defLook = DEFAULT_STATE.character.look;
  const hairIds = (typeof CharacterArt !== 'undefined' ? CharacterArt.HAIR_STYLES : []).map(h => h.id);
  const accIds  = (typeof CharacterArt !== 'undefined' ? CharacterArt.ACCESSORIES : []).map(a => a.id);
  const outfitIds = (typeof CharacterArt !== 'undefined' ? CharacterArt.OUTFIT_STYLES : []).map(o => o.id);
  const hairStyle = hairIds.includes(look.hairStyle) ? look.hairStyle : null;
  if (look.hairStyle && !hairStyle) errors.push(`hairStyle は ${hairIds.join(' / ')} のどれかにしてください`);
  const accessory = accIds.includes(look.accessory) ? look.accessory : (look.accessory ? null : 'none');
  if (look.accessory && accessory === null) errors.push(`accessory は ${accIds.join(' / ')} のどれかにしてください`);
  const outfitStyle = outfitIds.includes(look.outfitStyle) ? look.outfitStyle : (look.outfitStyle ? null : 'dress');
  if (look.outfitStyle && outfitStyle === null) errors.push(`outfitStyle は ${outfitIds.join(' / ')} のどれかにしてください`);

  // 色は #hex のみ受け付ける (SVG に埋め込むため厳格に)
  const hexRe = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  const color = (key) => {
    const v = look[key];
    if (v == null || v === '') return defLook[key];
    if (typeof v === 'string' && hexRe.test(v.trim())) return v.trim();
    errors.push(`${key} は #rrggbb 形式の色にしてください`);
    return defLook[key];
  };
  const hairColor = color('hairColor');
  const eyeColor = color('eyeColor');
  const skinTone = color('skinTone');
  const outfitColor = color('outfitColor');

  if (errors.length) return { ok: false, error: errors.join('\n') };

  return {
    ok: true,
    character: {
      name,
      personality,
      customLabel,
      basePersonality,
      customDialogue,
      customArt,
      firstPerson: String(obj.firstPerson || 'わたし').trim().slice(0, 8) || 'わたし',
      callName: String(obj.callName || '').trim().slice(0, 12), // 空なら適用時に現状維持
      suffix: String(obj.suffix || '').trim().slice(0, 4),
      look: {
        hairStyle: hairStyle || defLook.hairStyle,
        hairColor, eyeColor, skinTone, outfitColor,
        outfitStyle: outfitStyle || 'dress',
        accessory: accessory || 'none'
      }
    }
  };
}

function openPromptModal(kind) {
  const modal = document.getElementById('char-prompt-modal');
  const ta = document.getElementById('char-prompt-text');
  if (!modal || !ta) return;
  ta.value = kind === 'dialogue' ? buildDialoguePrompt()
    : kind === 'dates' ? buildDatesPrompt()
    : buildCharPrompt();
  modal.classList.remove('hidden');
}

function openCharPromptModal() {
  openPromptModal('char');
}

function copyCharPrompt() {
  const ta = document.getElementById('char-prompt-text');
  if (!ta) return;
  const done = () => showToast('📋 コピーしました');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(ta.value).then(done).catch(() => {
      ta.select();
      document.execCommand('copy');
      done();
    });
  } else {
    ta.select();
    document.execCommand('copy');
    done();
  }
}

function openCharImportModal(context) {
  importContext = context || 'settings';
  importedCharacter = null;
  const modal = document.getElementById('char-import-modal');
  if (!modal) return;
  document.getElementById('char-import-text').value = '';
  document.getElementById('char-import-error').classList.add('hidden');
  document.getElementById('char-import-preview').classList.add('hidden');
  document.getElementById('char-import-apply').disabled = true;
  const ow = document.getElementById('char-import-overwrite');
  if (ow) {
    ow.checked = false;
    // 初回セットアップ中はロスター概念がないので隠す
    const row = ow.closest('.import-overwrite-row');
    if (row) row.classList.toggle('hidden', importContext === 'setup');
  }
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('char-import-text').focus(), 100);
}

function closeCharImportModal() {
  const modal = document.getElementById('char-import-modal');
  if (modal) modal.classList.add('hidden');
  importedCharacter = null;
}

/** 貼り付け内容を解析してプレビュー更新 */
function refreshCharImportPreview() {
  const text = document.getElementById('char-import-text').value;
  const errEl = document.getElementById('char-import-error');
  const prevEl = document.getElementById('char-import-preview');
  const applyBtn = document.getElementById('char-import-apply');
  importedCharacter = null;
  applyBtn.disabled = true;

  if (!text.trim()) {
    errEl.classList.add('hidden');
    prevEl.classList.add('hidden');
    return;
  }

  let result;
  try {
    result = validateCharacterImport(parseCharacterJSON(text));
  } catch (e) {
    result = { ok: false, error: 'JSON を読み取れませんでした。コードブロックごと貼り付けても大丈夫です。' };
  }

  if (!result.ok) {
    errEl.textContent = result.error;
    errEl.classList.remove('hidden');
    prevEl.classList.add('hidden');
    return;
  }

  const ch = result.character;
  importedCharacter = ch;
  errEl.classList.add('hidden');
  prevEl.classList.remove('hidden');

  // プレビュー: 立ち絵+名前+性格+その子の声のサンプル
  const artEl = document.getElementById('char-import-preview-art');
  if (artEl) {
    if (ch.customArt) {
      artEl.innerHTML = ch.customArt.base; // サニタイズ済み
    } else if (typeof CharacterArt !== 'undefined') {
      artEl.innerHTML = CharacterArt.render(ch.look, 'smile');
    }
  }
  document.getElementById('char-import-preview-name').textContent = ch.name;
  const pLabel = ch.personality === 'custom'
    ? `💎 ${ch.customLabel}(ベース: ${PERSONALITY_NAMES[ch.basePersonality]})`
    : PERSONALITY_NAMES[ch.personality];
  const meta = [pLabel, `一人称「${ch.firstPerson}」`];
  if (ch.suffix) meta.push(`語尾「${ch.suffix}」`);
  if (ch.customDialogue) {
    const n = Object.keys(ch.customDialogue).filter(k => k !== 'praise' && k !== 'gift_reaction').length;
    meta.push(`セリフ集 ${n} 場面`);
  }
  if (ch.customArt) meta.push('オリジナル立ち絵');
  document.getElementById('char-import-preview-meta').textContent = meta.join(' · ');
  const sampleState = {
    affection: state ? state.affection : 0,
    character: Object.assign({}, ch, { callName: ch.callName || (state ? state.character.callName : 'あなた') })
  };
  const line = (typeof Dialogue !== 'undefined') ? Dialogue.get('setup_first', sampleState) : '';
  document.getElementById('char-import-preview-line').textContent = line ? `「${line}」` : '';

  applyBtn.disabled = false;
}

/** インポートを適用 (せってい: 即反映 / セットアップ: ウィザードに流し込み) */
function applyCharImport() {
  if (!importedCharacter) return;
  const ch = importedCharacter;

  if (importContext === 'setup') {
    wizardLook = Object.assign({}, ch.look);
    wizardPersonality = ch.personality;
    wizardCustom = (ch.personality === 'custom' || ch.customArt) ? {
      customLabel: ch.customLabel,
      basePersonality: ch.basePersonality,
      customDialogue: ch.customDialogue,
      customArt: ch.customArt
    } : null;
    buildWizardControls();
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal('s-firstPerson', ch.firstPerson);
    setVal('s-suffix', ch.suffix);
    setVal('s-charName', ch.name);
    if (ch.callName) setVal('s-callName', ch.callName);
    closeCharImportModal();
    goToStep(3); // 名前の確認だけして完了へ
    showToast(`💞 ${ch.name}が来ました`);
    return;
  }

  // せってい: 新しい子として迎える (上書きチェック時はいまの子に適用)
  const overwriteEl = document.getElementById('char-import-overwrite');
  const overwrite = overwriteEl ? overwriteEl.checked : false;
  if (!overwrite) {
    if (1 + state.roster.length >= ROSTER_MAX) {
      showToast(`キャラは${ROSTER_MAX}人まで。誰かとお別れするか「上書き」にしてください`);
      return;
    }
    // いまの子を控えに、新しい子は親密度ゼロから
    // (呼ばれたい名前はプレイヤー側の好みなので引き継ぐ)
    const prevCallName = state.character.callName;
    state.roster.unshift(snapshotActiveChar());
    state.character = JSON.parse(JSON.stringify(DEFAULT_STATE.character));
    state.character.rosterId = uid();
    state.character.callName = prevCallName;
    state.affection = 0;
    state.memories = [];
  }
  state.character.name = ch.name;
  state.character.personality = ch.personality;
  state.character.firstPerson = ch.firstPerson;
  state.character.suffix = ch.suffix;
  if (ch.callName) state.character.callName = ch.callName;
  state.character.look = Object.assign({}, ch.look);
  state.character.customLabel     = ch.customLabel || null;
  state.character.basePersonality = ch.basePersonality || null;
  state.character.customDialogue  = ch.customDialogue || null;
  state.character.customArt       = ch.customArt || null;
  saveState();

  closeCharImportModal();
  renderChara('home-chara', 'smile');
  initSettingsTab();
  showToast(`💞 ${ch.name}が来ました`);
  const speech = getSpeech('setup_first');
  showBubble(speech);
  switchTab('home');
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
    // 時間帯の変化を反映 (背景は常に、挨拶はスロットが変わったときだけ)
    const slot = currentTimeSlot();
    const roomBg = document.getElementById('room-bg');
    if (roomBg) roomBg.className = `room-bg time-${slot.base}`;
    if (_lastGreetSlotId !== null && _lastGreetSlotId !== slot.id) {
      _lastGreetSlotId = slot.id;
      showBubble(getSpeech(getGreetingSituation()));
      renderChara('home-chara', getDefaultExpression());
    }
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

// グローバル公開 (任意)
window.App = {
  state, saveState, switchTab,
  // FFX (focusflow.js) の save() から毎回呼ばれる
  onTasksChanged: function () { ffCheckExternalCompletions(); }
};
