'use strict';

/* art.js — 立ち絵 (SVGサニタイズ・カスタムアート・画像アップロード・表情差分) */

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

/** 登録済みの表情差分があるか (画像/SVG カスタム立ち絵) */
function hasExpressionVariants() {
  const art = state && state.character && state.character.customArt;
  return !!(art && art.expressions && Object.keys(art.expressions).length);
}

/** いま見せられる表情のプール。includeBase=true なら「きほん(normal)」も混ぜる */
function expressionPool(includeBase) {
  const art = state && state.character && state.character.customArt;
  if (hasExpressionVariants()) {
    const keys = Object.keys(art.expressions);
    return includeBase ? ['normal'].concat(keys) : keys;
  }
  if (art && (art.base || art.dataUrl)) return ['smile']; // 画像立ち絵・差分なし
  return ['smile', 'joy', 'blush', 'surprised'];          // パーツ立ち絵
}

/** プールから直前と違うものをランダムに選ぶ (memoKey ごとに直近を記憶) */
function pickExpression(pool, memoKey) {
  pickExpression._last = pickExpression._last || {};
  const last = pickExpression._last[memoKey];
  const choices = pool.filter(e => e !== last);
  const arr = choices.length ? choices : pool;
  const pick = arr[Math.floor(Math.random() * arr.length)];
  pickExpression._last[memoKey] = pick;
  return pick;
}

/** 立ち絵タップ時の表情。登録済みの差分を順に見せる (= ちゃんと使われる) */
function homeIdleExpression() {
  return pickExpression(expressionPool(false), 'idle');
}

/** ホームで休憩中に見せる表情。差分があれば巡回して固定にしない */
function homeRestExpression() {
  if (hasExpressionVariants()) return pickExpression(expressionPool(true), 'rest');
  return 'normal';
}

/** プリセットセリフ用の性格 (カスタム時はベース性格に解決) */
function effectivePersonality() {
  if (typeof Dialogue !== 'undefined' && Dialogue.resolvePersonality) {
    return Dialogue.resolvePersonality(state);
  }
  return PERSONALITY_NAMES[state.character.personality] ? state.character.personality : 'tsundere';
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
