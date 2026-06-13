'use strict';

/* shopdate.js — ショップ・おでかけ一覧・デートエディタ・VN */

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
  const rawItem = pickRandom(reactions, null);
  const rawText = (rawItem && typeof rawItem === 'object' ? rawItem.text : rawItem || '').replace(/\{gift\}/g, gift.name);
  const lineExpr = (rawItem && typeof rawItem === 'object' && rawItem.expr) ? rawItem.expr : null;
  const text = (typeof Dialogue !== 'undefined') ? Dialogue.format(rawText, state) : rawText;

  // memories
  state.memories.unshift({
    date: todayStr(),
    type: 'gift',
    label: `${gift.icon}${gift.name}をプレゼントした`
  });

  saveState();

  // UI 更新
  showBubble(text, lineExpr || (Math.random() < 0.5 ? 'joy' : 'blush'));
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
