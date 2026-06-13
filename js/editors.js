'use strict';

/* editors.js — セリフエディタ・部分インポート・キャラインポート */

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
