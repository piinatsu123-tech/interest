'use strict';

/* settings.js — せってい・ロスター・時間帯エディタ・ウィザード */

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
  openRoom();
  showBubble(speech);
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
    // お部屋を開いていれば背景・挨拶に即反映
    if (typeof isRoomVisible === 'function' && isRoomVisible()) renderHome(false);
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

  // セットアップ画面を隠してメインを表示。初対面はお部屋で出迎える
  document.getElementById('screen-setup').classList.add('hidden');
  document.getElementById('screen-main').classList.remove('hidden');

  prepareRoom();
  openRoom();

  // setup_first セリフ
  setTimeout(() => {
    const speech = getSpeech('setup_first');
    showBubble(speech, 'smile');
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
