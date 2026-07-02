'use strict';
/* =========================================================
   flowclean.js — FlowClean 家事フロー (いっしょぐらし統合版)
   piinatsu123-tech/flowclean を移植。
   - DOM: index.html 内の #ffx-tab-fc (そうじタブ) 内の #fc-app へ描画
   - データ: localStorage 'fc_states' / 'fc_env_list' / 'fc_reward_images' / 'fc_reward_msgs'
   - 公開: window.FC (index.html 側の onclick 委譲・focusflow.js 連携用)
   - 変更点: CSS/DOM を .fc- プレフィックスでスコープ、フロー完了時に
     いっしょぐらし側のコイン・親密度報酬とキャラのリアクションを発生させる
     (App.rewardChoreComplete / App.showChoreReaction 経由)
   ========================================================= */
(function () {

// ── SOUND ────────────────────────────────────────────────────────────────────

const Sound = {
  _ctx: null,
  ctx() {
    if (!this._ctx) {
      try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(_) {}
    }
    if (this._ctx?.state === 'suspended') this._ctx.resume();
    return this._ctx;
  },
  tap() {
    const ctx = this.ctx(); if (!ctx) return;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 2000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    src.connect(hpf); hpf.connect(gain); gain.connect(ctx.destination);
    src.start(t); src.stop(t + 0.07);
  },
  done() {
    const ctx = this.ctx(); if (!ctx) return;
    const t = ctx.currentTime;
    const chirp = (st, f1, f2, dur) => {
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modG = ctx.createGain();
      const outG = ctx.createGain();
      car.type = 'sine'; mod.type = 'sine';
      mod.frequency.value = 14; modG.gain.value = 35;
      car.frequency.setValueAtTime(f1, st);
      car.frequency.exponentialRampToValueAtTime(f2, st + dur * 0.55);
      car.frequency.exponentialRampToValueAtTime(f1 * 0.9, st + dur);
      outG.gain.setValueAtTime(0, st);
      outG.gain.linearRampToValueAtTime(0.15, st + 0.018);
      outG.gain.setValueAtTime(0.15, st + dur - 0.04);
      outG.gain.exponentialRampToValueAtTime(0.001, st + dur);
      mod.connect(modG); modG.connect(car.frequency);
      car.connect(outG); outG.connect(ctx.destination);
      mod.start(st); mod.stop(st + dur + 0.05);
      car.start(st); car.stop(st + dur + 0.05);
    };
    chirp(t,        2100, 2900, 0.13);
    chirp(t + 0.22, 2100, 2900, 0.13);
    chirp(t + 0.50, 1900, 2600, 0.28);
  },
};

const VERSION = '2.0';

// ── DATA ──────────────────────────────────────────────────────────────────────

const STATES = [
  {
    id: 'cooking', label: '料理中',
    events: [
      { id: 'spill',       label: '吹きこぼれ',
        defer: '加熱中の場合は先に火を止める',
        steps: ['鍋を外す', '灰布を取る（{gray_cloth}）', '1回拭く', '{cloth_basket}へ'] },
      { id: 'oil_splash',  label: '油はね',
        steps: ['アルコールスプレー（{alcohol_spray}）', '灰布で拭く', '{cloth_basket}へ'] },
      { id: 'cut_done',    label: 'カット完了',
        steps: ['まな板を立てかける', '包丁を洗う', '切りかすを{trash_bin}へ'] },
      { id: 'dish_done',   label: '料理完成',
        steps: ['ボウルをシンクへ', 'IHをオフ'] },
    ]
  },
  {
    id: 'desk', label: 'デスク作業',
    events: [
      { id: 'cup_empty',  label: 'カップが空',  steps: ['カップをシンクへ'] },
      { id: 'trash',      label: 'ゴミ発生',   steps: ['{trash_bin}へ'] },
      { id: 'paper_done', label: '書類完了',   steps: ['ファイルかシュレッダーへ', 'デスクを確認'] },
    ]
  },
  {
    id: 'eating', label: '食事中',
    events: [
      { id: 'meal_done',   label: '食事完了',
        steps: ['皿をシンクへ', 'テーブルを灰布で拭く（{gray_cloth}）', '{cloth_basket}へ'] },
      { id: 'spill_table', label: 'こぼした',
        steps: ['灰布で即拭く（{gray_cloth}）', '{cloth_basket}へ'] },
    ]
  },
  {
    id: 'return_home', label: '帰宅',
    events: [
      { id: 'arrived', label: '帰宅した',
        steps: ['鍵をフックへ', 'バッグを定位置へ', '上着をハンガーへ'] },
    ]
  },
  {
    id: 'before_sleep', label: '就寝前',
    events: [
      { id: 'floor_chk', label: '床確認',    steps: ['床のものを定位置へ'] },
      { id: 'sink_chk',  label: 'シンク確認', steps: ['残した皿があれば浸け置き', 'なければOK'] },
    ]
  },
  {
    id: 'laundry', label: '洗濯',
    events: [
      { id: 'wash_done', label: '洗い終わり',
        steps: ['洗濯物を取り出す', '干す', '洗濯機の蓋を開けたまま'] },
      { id: 'dry_done',  label: '乾燥完了',
        steps: ['取り込む', 'たたむ（即）', '定位置へ'] },
    ]
  },
];

const DEFAULT_ENV_LIST = [
  { key: 'gray_cloth',    label: '灰布の場所',  value: 'IH右' },
  { key: 'alcohol_spray', label: 'アルコール',  value: 'シンク横' },
  { key: 'trash_bin',     label: 'ゴミ箱',      value: '下引き出し' },
  { key: 'cloth_basket',  label: '使用済み布',  value: '左かご' },
];

// ── APP ───────────────────────────────────────────────────────────────────────

const FC = {
  screen: 'home',
  state:  null,
  event:  null,
  step:   0,
  deferPending: false,
  envList: DEFAULT_ENV_LIST.map(e => ({ ...e })),
  rewardImages: [],
  rewardMessages: [],
  rewardUrl: null,
  customStates: null,
  editStateId:  null,
  editEventId:  null,
  draft: null,

  getStates() { return this.customStates ?? STATES; },

  ensureCustomStates() {
    if (!this.customStates) {
      this.customStates = JSON.parse(JSON.stringify(STATES));
    }
  },

  saveStates() {
    localStorage.setItem('fc_states', JSON.stringify(this.customStates));
  },

  saveEnv() {
    localStorage.setItem('fc_env_list', JSON.stringify(this.envList));
  },

  saveRewardImages() {
    try {
      localStorage.setItem('fc_reward_images', JSON.stringify(this.rewardImages));
    } catch(_) {
      alert('画像の保存に失敗しました。容量が不足している可能性があります。');
    }
  },

  saveRewardMessages() {
    localStorage.setItem('fc_reward_msgs', JSON.stringify(this.rewardMessages));
  },

  newId() { return 'x' + Date.now(); },

  nextEnvKey() {
    const used = new Set(this.envList.map(e => e.key));
    let n = 0;
    while (used.has('u' + n)) n++;
    return 'u' + n;
  },

  collectDraft() {
    const labelEl = document.getElementById('fc-ev-label');
    const deferEl = document.getElementById('fc-ev-defer');
    const stepEls = document.querySelectorAll('#fc-app .fc-step-inp');
    if (labelEl) this.draft.label = labelEl.value;
    if (deferEl) this.draft.defer = deferEl.value;
    this.draft.steps = Array.from(stepEls).map(e => e.value);
  },

  collectEnvForm() {
    return Array.from(document.querySelectorAll('#fc-app .fc-env-card')).map(card => ({
      key:   card.dataset.key,
      label: card.querySelector('.fc-env-name-inp').value.trim(),
      value: card.querySelector('.fc-env-val-inp').value.trim(),
    }));
  },

  handleImageUpload(file) {
    if (!file) return;
    const valid = ['image/jpeg', 'image/png', 'image/webp'];
    if (!valid.includes(file.type)) {
      alert('jpg / png / webp のみ対応しています');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1080;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else       { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        this.rewardImages.push({ id: 'r' + Date.now(), dataUrl });
        this.saveRewardImages();
        if (this.screen === 'settings') this.render();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },

  init() {
    try {
      const el = localStorage.getItem('fc_env_list');
      if (el) {
        this.envList = JSON.parse(el);
      }
      const cs = localStorage.getItem('fc_states');
      if (cs) this.customStates = JSON.parse(cs);
      const ri = localStorage.getItem('fc_reward_images');
      if (ri) this.rewardImages = JSON.parse(ri);
      const rm = localStorage.getItem('fc_reward_msgs');
      if (rm) this.rewardMessages = JSON.parse(rm);
    } catch(_) {}

    // レンダリングは そうじタブが開かれたとき (FFX.switchTab('fc')) に行う

    document.addEventListener('click', e => {
      const el = e.target.closest('[data-a]');
      if (!el || !el.closest('#fc-app')) return;
      Sound.tap();
      this.handle(el.dataset.a, el.dataset.v);
    });
    document.addEventListener('change', e => {
      if (e.target.id === 'fc-reward-file-input') {
        Array.from(e.target.files).forEach(f => this.handleImageUpload(f));
      }
    });
  },

  handle(action, val) {
    if (action === 'tab') {
      this.screen = val;

    } else if (action === 'state') {
      this.state = this.getStates().find(s => s.id === val);
      this.screen = 'events';

    } else if (action === 'event') {
      this.event = this.state.events.find(e => e.id === val);
      this.step = 0;
      this.deferPending = !!this.event.defer;
      this.screen = 'flow';

    } else if (action === 'defer-ok') {
      this.deferPending = false;

    } else if (action === 'next') {
      if (this.step < this.event.steps.length - 1) {
        this.step++;
      } else {
        this.screen = 'done';
        Sound.done();
        // いっしょぐらし側の報酬 (コイン・親密度) を付与。キャラのリアクションは
        // ご褒美ポップアップを閉じた後 (または無ければ自動タイムアウト後) に見せる
        if (window.App && App.rewardChoreComplete) App.rewardChoreComplete(this.event.label);
        if (this.rewardImages.length > 0) {
          const idx = Math.floor(Math.random() * this.rewardImages.length);
          this.rewardUrl = this.rewardImages[idx].dataUrl;
          this.render();
        } else {
          this.render();
          setTimeout(() => {
            this.screen = 'home'; this.state = null; this.event = null; this.step = 0;
            this.render();
            if (window.App && App.showChoreReaction) App.showChoreReaction();
          }, 1800);
        }
        return;
      }

    } else if (action === 'dismiss-reward') {
      this.rewardUrl = null;
      this.screen = 'home';
      this.state = null; this.event = null; this.step = 0;
      if (window.App && App.showChoreReaction) App.showChoreReaction();

    } else if (action === 'back') {
      if      (this.screen === 'flow')       { this.screen = 'events'; this.event = null; this.step = 0; }
      else if (this.screen === 'events')     { this.screen = 'home'; this.state = null; }
      else if (this.screen === 'settings')   { this.screen = 'home'; }
      else if (this.screen === 'edit_event') { this.draft = null; this.editEventId = null; this.screen = 'edit_state'; }
      else if (this.screen === 'edit_state') { this.editStateId = null; this.screen = 'edit'; }

    } else if (action === 'settings') {
      this.screen = 'settings';

    // ── 道具の場所 ──
    } else if (action === 'save') {
      const collected = this.collectEnvForm().filter(e => e.label);
      this.envList = collected;
      this.saveEnv();
      this.screen = 'home';

    } else if (action === 'add-env') {
      const current = this.collectEnvForm();
      current.push({ key: this.nextEnvKey(), label: '', value: '' });
      this.envList = current;
      this.render();
      const inputs = document.querySelectorAll('#fc-app .fc-env-name-inp');
      if (inputs.length) {
        const last = inputs[inputs.length - 1];
        last.focus();
        last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return;

    } else if (action === 'del-env') {
      const current = this.collectEnvForm();
      this.envList = current.filter(e => e.key !== val);

    // ── ご褒美メッセージ ──
    } else if (action === 'add-msg') {
      const text = prompt('メッセージを入力');
      if (text && text.trim()) {
        this.rewardMessages.push({ id: 'msg' + Date.now(), text: text.trim() });
        this.saveRewardMessages();
      }

    } else if (action === 'edit-msg') {
      const msg = this.rewardMessages.find(m => m.id === val);
      if (!msg) return;
      const text = prompt('メッセージを編集', msg.text);
      if (text !== null && text.trim()) { msg.text = text.trim(); this.saveRewardMessages(); }

    } else if (action === 'del-msg') {
      this.rewardMessages = this.rewardMessages.filter(m => m.id !== val);
      this.saveRewardMessages();

    // ── ご褒美画像 ──
    } else if (action === 'del-reward') {
      this.rewardImages = this.rewardImages.filter(r => r.id !== val);
      this.saveRewardImages();

    // ── 状態編集 ──
    } else if (action === 'edit-state') {
      this.editStateId = val;
      this.screen = 'edit_state';

    } else if (action === 'save-state-label') {
      this.ensureCustomStates();
      const labelEl = document.getElementById('fc-st-label');
      const st = this.customStates.find(s => s.id === this.editStateId);
      if (st && labelEl && labelEl.value.trim()) {
        st.label = labelEl.value.trim();
        this.saveStates();
      }

    } else if (action === 'add-state') {
      this.ensureCustomStates();
      const id = this.newId();
      this.customStates.push({ id, label: '新しい状態', events: [] });
      this.saveStates();
      this.editStateId = id;
      this.screen = 'edit_state';

    } else if (action === 'delete-state') {
      if (!confirm('この状態を削除しますか？')) return;
      this.ensureCustomStates();
      this.customStates = this.customStates.filter(s => s.id !== this.editStateId);
      this.saveStates();
      this.editStateId = null;
      this.screen = 'edit';

    // ── イベント編集 ──
    } else if (action === 'edit-event') {
      this.ensureCustomStates();
      const st = this.customStates.find(s => s.id === this.editStateId);
      const ev = st?.events.find(e => e.id === val);
      if (ev) {
        this.editEventId = val;
        this.draft = JSON.parse(JSON.stringify(ev));
        this.screen = 'edit_event';
      }

    } else if (action === 'add-event') {
      this.ensureCustomStates();
      const st = this.customStates.find(s => s.id === this.editStateId);
      if (st) {
        const id = this.newId();
        const newEv = { id, label: '新しいイベント', steps: [''] };
        st.events.push(newEv);
        this.saveStates();
        this.editEventId = id;
        this.draft = JSON.parse(JSON.stringify(newEv));
        this.screen = 'edit_event';
      }

    } else if (action === 'save-event') {
      this.collectDraft();
      this.draft.label = this.draft.label.trim() || '(無名)';
      this.draft.steps = this.draft.steps.filter(s => s.trim());
      if (!this.draft.defer?.trim()) delete this.draft.defer;
      else this.draft.defer = this.draft.defer.trim();
      this.ensureCustomStates();
      const st = this.customStates.find(s => s.id === this.editStateId);
      if (st) {
        const idx = st.events.findIndex(e => e.id === this.editEventId);
        if (idx >= 0) st.events[idx] = this.draft;
      }
      this.saveStates();
      this.draft = null;
      this.editEventId = null;
      this.screen = 'edit_state';

    } else if (action === 'delete-event') {
      if (!confirm('このイベントを削除しますか？')) return;
      this.ensureCustomStates();
      const st = this.customStates.find(s => s.id === this.editStateId);
      if (st) st.events = st.events.filter(e => e.id !== this.editEventId);
      this.saveStates();
      this.draft = null;
      this.editEventId = null;
      this.screen = 'edit_state';

    // ── ステップ操作 ──
    } else if (action === 'add-step') {
      this.collectDraft();
      this.draft.steps.push('');
      this.render();
      const inputs = document.querySelectorAll('#fc-app .fc-step-inp');
      if (inputs.length) {
        const last = inputs[inputs.length - 1];
        last.focus();
        last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      return;

    } else if (action === 'del-step') {
      this.collectDraft();
      this.draft.steps.splice(parseInt(val), 1);
    }

    this.render();
  },

  // ステップ本文・道具の場所はどちらもユーザー入力なので、置換前に必ず
  // esc() で HTML エスケープしてから {変数} を展開する (未エスケープの innerHTML 注入を防止)
  fill(text) {
    const map = Object.fromEntries(this.envList.map(e => [e.key, e.value]));
    return esc(text).replace(/\{(\w+)\}/g, (_, k) => esc(map[k] != null ? map[k] : k));
  },

  render() {
    const el = document.getElementById('fc-app');
    if (!el) return;
    el.innerHTML = this['$' + this.screen]();
  },

  // ── COMPONENTS ──────────────────────────────────────────────────────────────

  $tabBar(active) {
    return `<div class="fc-tab-bar">
      <button class="fc-tab-btn ${active === 'home' ? 'active' : ''}" data-a="tab" data-v="home">
        <span class="fc-tab-btn-label">ホーム</span>
      </button>
      <button class="fc-tab-btn ${active === 'edit' ? 'active' : ''}" data-a="tab" data-v="edit">
        <span class="fc-tab-btn-label">編集</span>
      </button>
    </div>`;
  },

  // ── SCREENS ─────────────────────────────────────────────────────────────────

  $home() {
    const btns = this.getStates().map(s =>
      `<button class="fc-state-btn" data-a="state" data-v="${s.id}">
        <span class="fc-state-label">${esc(s.label)}</span>
       </button>`
    ).join('');
    return `
      <div class="fc-hd">
        <div class="fc-logo-wrap">
          <span class="fc-logo">FlowClean</span>
          <span class="fc-logo-ver">v${VERSION}</span>
        </div>
        <button class="fc-hd-icon-btn" data-a="settings">&#9881;</button>
      </div>
      <div class="fc-scroll">
        <div class="fc-label">今、何してる？</div>
        <div class="fc-state-grid">${btns}</div>
      </div>
      ${this.$tabBar('home')}`;
  },

  $edit() {
    const cards = this.getStates().map(s =>
      `<div class="fc-edit-card" data-a="edit-state" data-v="${s.id}">
        <span class="fc-edit-card-label">${esc(s.label)}</span>
        <span class="fc-edit-card-arrow">›</span>
       </div>`
    ).join('');
    return `
      <div class="fc-hd">
        <div class="fc-logo-wrap">
          <span class="fc-logo">FlowClean</span>
          <span class="fc-logo-ver">v${VERSION}</span>
        </div>
        <button class="fc-hd-icon-btn" data-a="settings">&#9881;</button>
      </div>
      <div class="fc-scroll">
        <div class="fc-label">状態一覧</div>
        ${cards}
        <button class="fc-btn-ghost" data-a="add-state">+ 状態を追加</button>
      </div>
      ${this.$tabBar('edit')}`;
  },

  $edit_state() {
    const st = this.getStates().find(s => s.id === this.editStateId);
    if (!st) { this.screen = 'edit'; return this.$edit(); }
    const eventCards = st.events.map(e =>
      `<div class="fc-edit-card" data-a="edit-event" data-v="${e.id}">
        <span class="fc-edit-card-label">${esc(e.label)}</span>
        <span class="fc-edit-card-arrow">›</span>
       </div>`
    ).join('');
    return `
      <div class="fc-hd">
        <button class="fc-hd-back" data-a="back">‹ 戻る</button>
        <span class="fc-hd-title">状態を編集</span>
      </div>
      <div class="fc-scroll">
        <div class="fc-form-section">
          <div class="fc-form-label">状態名</div>
          <input id="fc-st-label" class="fc-edit-input" type="text" value="${esc(st.label)}" autocomplete="off">
          <button class="fc-btn-primary" data-a="save-state-label">保存</button>
        </div>
        <div class="fc-form-section" style="margin-top:4px">
          <div class="fc-form-label">イベント</div>
          ${eventCards || '<div class="fc-empty-msg">まだイベントがありません</div>'}
          <button class="fc-btn-ghost" data-a="add-event">+ イベントを追加</button>
        </div>
        <button class="fc-btn-danger" data-a="delete-state">この状態を削除</button>
      </div>`;
  },

  $edit_event() {
    const d = this.draft;
    if (!d) { this.screen = 'edit_state'; return this.$edit_state(); }
    const stepRows = d.steps.map((s, i) =>
      `<div class="fc-step-row">
        <span class="fc-step-num">${i + 1}</span>
        <input class="fc-step-inp" type="text" value="${esc(s)}" placeholder="ステップ ${i + 1}" autocomplete="off">
        <button class="fc-step-del-btn" data-a="del-step" data-v="${i}">×</button>
       </div>`
    ).join('');
    return `
      <div class="fc-hd">
        <button class="fc-hd-back" data-a="back">‹ 戻る</button>
        <span class="fc-hd-title">イベントを編集</span>
      </div>
      <div class="fc-scroll">
        <div class="fc-form-section">
          <div class="fc-form-label">イベント名</div>
          <input id="fc-ev-label" class="fc-edit-input" type="text" value="${esc(d.label)}" autocomplete="off">
        </div>
        <div class="fc-form-section">
          <div class="fc-form-label">事前確認（任意）</div>
          <input id="fc-ev-defer" class="fc-edit-input" type="text" value="${esc(d.defer || '')}" placeholder="例：火を止めてから" autocomplete="off">
        </div>
        <div class="fc-form-section">
          <div class="fc-form-label">ステップ</div>
          <div class="fc-form-hint">{変数名} で道具の場所を参照できます</div>
          <div class="fc-step-rows">${stepRows}</div>
          <button class="fc-btn-ghost" data-a="add-step">+ ステップを追加</button>
        </div>
        <button class="fc-btn-danger" data-a="delete-event">このイベントを削除</button>
      </div>
      <div class="fc-bottom">
        <button class="fc-btn-primary" data-a="save-event">保存</button>
      </div>`;
  },

  $events() {
    const s = this.state;
    const btns = s.events.map(e =>
      `<button class="fc-event-btn" data-a="event" data-v="${e.id}">
        <span class="fc-event-label">${esc(e.label)}</span>
        <span class="fc-event-arrow">›</span>
       </button>`
    ).join('');
    return `
      <div class="fc-hd">
        <button class="fc-hd-back" data-a="back">‹ 戻る</button>
        <span class="fc-hd-title">${esc(s.label)}</span>
      </div>
      <div class="fc-scroll">
        <div class="fc-label">何が起きた？</div>
        ${btns}
      </div>`;
  },

  $flow() {
    const ev = this.event;

    if (this.deferPending) {
      return `
        <div class="fc-hd">
          <button class="fc-hd-back" data-a="back">‹ 戻る</button>
          <span class="fc-hd-title">${esc(ev.label)}</span>
        </div>
        <div class="fc-scroll-center" data-a="defer-ok" style="cursor:pointer">
          <div class="fc-defer-box">
            <div class="fc-defer-msg">${esc(ev.defer)}</div>
          </div>
          <div class="fc-flow-tap-hint" style="margin-top:24px">タップして続ける</div>
        </div>`;
    }

    const total = ev.steps.length;
    const isLast = this.step === total - 1;
    const doneHtml = ev.steps.slice(0, this.step).map(s =>
      `<div class="fc-done-step">
        <span class="fc-done-check">✓</span>
        <span class="fc-done-step-text">${this.fill(s)}</span>
       </div>`
    ).join('');

    return `
      <div class="fc-hd">
        <button class="fc-hd-back" data-a="back">‹ 戻る</button>
        <span class="fc-hd-title">${esc(ev.label)}</span>
        <span class="fc-hd-meta">${this.step + 1} / ${total}</span>
      </div>
      <div class="fc-flow-body">
        ${doneHtml ? `<div class="fc-flow-done-list">${doneHtml}</div>` : ''}
        <div class="fc-flow-center">
          <div class="fc-flow-current" data-a="next">
            <div class="fc-step-text">${this.fill(ev.steps[this.step])}</div>
            <div class="fc-flow-tap-hint">${isLast ? '完了' : 'タップで次へ'}</div>
          </div>
        </div>
      </div>`;
  },

  $done() {
    let popup = '';
    if (this.rewardUrl) {
      const msg = this.rewardMessages.length > 0
        ? this.rewardMessages[Math.floor(Math.random() * this.rewardMessages.length)].text
        : null;
      popup = `
        <div class="fc-reward-overlay" data-a="dismiss-reward">
          <div class="fc-reward-popup" onclick="event.stopPropagation()">
            <img class="fc-reward-img" src="${this.rewardUrl}" alt="">
            ${msg ? `<div class="fc-reward-msg">${esc(msg)}</div>` : ''}
            <button class="fc-reward-close-btn" onclick="FC.handle('dismiss-reward')">×</button>
          </div>
        </div>`;
    }
    return `
      <div class="fc-scroll-center">
        <div class="fc-done-ring">✓</div>
        <div class="fc-done-title">完了</div>
        <div class="fc-done-sub">${esc(this.event?.label || '')}</div>
      </div>
      ${popup}`;
  },

  $settings() {
    const envCards = this.envList.map(e =>
      `<div class="fc-env-card" data-key="${e.key}">
        <div class="fc-env-name-row">
          <input class="fc-env-name-inp" type="text" value="${esc(e.label)}" placeholder="道具の名称" autocomplete="off">
          <button class="fc-env-del-btn" data-a="del-env" data-v="${e.key}">×</button>
        </div>
        <div class="fc-env-val-row">
          <input class="fc-env-val-inp" type="text" value="${esc(e.value)}" placeholder="場所を入力" autocomplete="off">
        </div>
        <div class="fc-env-key-hint">{${e.key}}</div>
       </div>`
    ).join('');

    const thumbs = this.rewardImages.map(r =>
      `<div class="fc-reward-thumb-wrap">
        <img class="fc-reward-thumb" src="${r.dataUrl}" alt="">
        <button class="fc-reward-del-btn" data-a="del-reward" data-v="${r.id}">×</button>
       </div>`
    ).join('');

    return `
      <div class="fc-hd">
        <button class="fc-hd-back" data-a="back">‹ 戻る</button>
        <span class="fc-hd-title">設定</span>
      </div>
      <div class="fc-scroll">
        <div class="fc-label">環境マップ</div>
        <div class="fc-form-hint" style="padding:0 4px">ステップ内で {変数名} と入力すると場所に変換されます</div>
        ${envCards}
        <button class="fc-btn-ghost" data-a="add-env">+ 道具を追加</button>
        <button class="fc-btn-primary" data-a="save">道具の場所を保存</button>

        <div class="fc-section-sep"></div>

        <div class="fc-label">ご褒美画像</div>
        <div class="fc-form-hint" style="padding:0 4px">そうじ完了後にランダムで表示されます</div>
        ${thumbs.length ? `<div class="fc-reward-thumbs">${thumbs}</div>` : '<div class="fc-empty-msg">まだ画像がありません</div>'}
        <label class="fc-btn-ghost" for="fc-reward-file-input">+ 画像を追加</label>
        <input type="file" id="fc-reward-file-input" accept="image/jpeg,image/png,image/webp" multiple style="display:none">

        <div class="fc-section-sep"></div>

        <div class="fc-label">ご褒美メッセージ</div>
        <div class="fc-form-hint" style="padding:0 4px">画像の上にランダムで重ねて表示されます</div>
        ${this.rewardMessages.length ? this.rewardMessages.map(m => `
          <div class="fc-msg-row" data-a="edit-msg" data-v="${m.id}" style="cursor:pointer">
            <span class="fc-msg-text">${esc(m.text)}</span>
            <button class="fc-env-del-btn" data-a="del-msg" data-v="${m.id}">×</button>
          </div>`).join('') : '<div class="fc-empty-msg">まだメッセージがありません</div>'}
        <button class="fc-btn-ghost" data-a="add-msg">+ メッセージを追加</button>
      </div>`;
  },
};

FC.init();
window.FC = FC;
})();
