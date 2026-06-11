'use strict';

/* CharacterArt — パーツ合成式のデフォルメ立ち絵 SVG レンダラー
   契約は DESIGN.md を参照。render() は SVG マークアップ文字列を返す。 */

(function () {

  const HAIR_STYLES = [
    { id: 'short',    name: 'ショート' },
    { id: 'bob',      name: 'ボブ' },
    { id: 'long',     name: 'ロング' },
    { id: 'twintail', name: 'ツインテール' },
    { id: 'ponytail', name: 'ポニーテール' },
  ];

  const ACCESSORIES = [
    { id: 'none',    name: 'なし' },
    { id: 'ribbon',  name: 'リボン' },
    { id: 'glasses', name: 'メガネ' },
    { id: 'flower',  name: 'お花' },
  ];

  const EXPRESSIONS = ['normal', 'smile', 'joy', 'blush', 'pout', 'sad', 'surprised', 'sleepy'];

  const DEFAULT_LOOK = {
    hairStyle: 'long',
    hairColor: '#6b4f3a',
    eyeColor: '#4a6fa5',
    skinTone: '#ffe3cf',
    outfitColor: '#e8718d',
    accessory: 'none',
  };

  // ── color helpers ─────────────────────────────────────────────────────────

  // innerHTML に流し込むため、色値は厳格に検証する(不正値はデフォルトへ)
  function safeColor(c, fallback) {
    return (typeof c === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c)) ? c : fallback;
  }

  function hexToRgb(hex) {
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // f > 0 で白方向、f < 0 で黒方向に混ぜる
  function shade(hex, f) {
    const [r, g, b] = hexToRgb(hex);
    const t = f > 0 ? 255 : 0;
    const a = Math.abs(f);
    const mix = v => Math.round(v + (t - v) * a);
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  }

  // ── face parts ────────────────────────────────────────────────────────────
  // 顔の基準: 頭は楕円 (cx100, cy95, rx54, ry50)。目は cy≈100、口は (100,127)

  const LASH = '#503a33';

  function eyeOpen(cx, eyeCol, irisShift, lidDrop) {
    const sx = irisShift || 0;
    const lid = lidDrop || 0;
    const dark = shade(eyeCol, -0.45);
    let s = '';
    s += `<ellipse cx="${cx}" cy="100" rx="9" ry="11" fill="#fff"/>`;
    s += `<ellipse cx="${cx + sx}" cy="101" rx="6.5" ry="9" fill="${eyeCol}"/>`;
    s += `<ellipse cx="${cx + sx}" cy="103.5" rx="4" ry="5" fill="${dark}"/>`;
    s += `<circle cx="${cx + sx - 2}" cy="97" r="2.4" fill="#fff"/>`;
    s += `<circle cx="${cx + sx + 2.5}" cy="105" r="1.2" fill="#fff" opacity="0.85"/>`;
    if (lid > 0) { // まぶた(眠そう/伏し目)
      s += `<path d="M ${cx - 10},${92 + lid} A 10 12 0 0 1 ${cx + 10},${92 + lid} L ${cx + 10},86 L ${cx - 10},86 Z" fill="inherit" class="lid"/>`;
      s += `<path d="M ${cx - 10},${92 + lid} A 10 12 0 0 1 ${cx + 10},${92 + lid}" fill="none" stroke="${LASH}" stroke-width="2.4" stroke-linecap="round"/>`;
    }
    // 上まつげ
    s += `<path d="M ${cx - 10},96 A 10 8 0 0 1 ${cx + 10},96" fill="none" stroke="${LASH}" stroke-width="3" stroke-linecap="round"/>`;
    return s;
  }

  function eyeHappy(cx) { // にっこり(∩)
    return `<path d="M ${cx - 9},103 Q ${cx},91 ${cx + 9},103" fill="none" stroke="${LASH}" stroke-width="3.2" stroke-linecap="round"/>`;
  }

  function eyeSadClosed(cx) { // しょんぼり(∪)
    return `<path d="M ${cx - 9},99 Q ${cx},108 ${cx + 9},99" fill="none" stroke="${LASH}" stroke-width="3" stroke-linecap="round"/>`;
  }

  function eyeWide(cx, eyeCol) { // びっくり
    let s = '';
    s += `<circle cx="${cx}" cy="100" r="10.5" fill="#fff" stroke="${LASH}" stroke-width="2.2"/>`;
    s += `<circle cx="${cx}" cy="101" r="4.5" fill="${eyeCol}"/>`;
    s += `<circle cx="${cx - 1.5}" cy="98.5" r="1.6" fill="#fff"/>`;
    return s;
  }

  function browsAt(yIn, yOut, w) { // 左右対称の眉。yIn=内端, yOut=外端
    const lw = w || 2.6;
    return `<path d="M 70,${yOut} Q 78,${(yIn + yOut) / 2 - 2} 87,${yIn}" fill="none" stroke="${LASH}" stroke-width="${lw}" stroke-linecap="round"/>` +
           `<path d="M 130,${yOut} Q 122,${(yIn + yOut) / 2 - 2} 113,${yIn}" fill="none" stroke="${LASH}" stroke-width="${lw}" stroke-linecap="round"/>`;
  }

  const MOUTH = {
    soft:      `<path d="M 94,127 Q 100,131 106,127" fill="none" stroke="#c2565e" stroke-width="2.6" stroke-linecap="round"/>`,
    smile:     `<path d="M 91,126 Q 100,134 109,126" fill="none" stroke="#c2565e" stroke-width="2.8" stroke-linecap="round"/>`,
    openJoy:   `<path d="M 90,124 Q 100,138 110,124 Q 100,129 90,124 Z" fill="#a8424c"/>` +
               `<path d="M 94,131 Q 100,136 106,131 Q 100,138 94,131 Z" fill="#e98b94"/>`,
    wavy:      `<path d="M 93,127 Q 96.5,124.5 100,127 Q 103.5,129.5 107,127" fill="none" stroke="#c2565e" stroke-width="2.4" stroke-linecap="round"/>`,
    pout:      `<path d="M 95,129 Q 100,124 105,129" fill="none" stroke="#c2565e" stroke-width="2.6" stroke-linecap="round"/>`,
    frown:     `<path d="M 93,129 Q 100,124 107,129" fill="none" stroke="#c2565e" stroke-width="2.4" stroke-linecap="round"/>`,
    o:         `<ellipse cx="100" cy="128" rx="4.5" ry="5.5" fill="#a8424c"/>`,
    tiny:      `<path d="M 96,128 Q 100,130 104,128" fill="none" stroke="#c2565e" stroke-width="2.2" stroke-linecap="round"/>`,
  };

  function blushMarks(opacity) {
    if (!opacity) return '';
    return `<ellipse cx="73" cy="114" rx="9.5" ry="5" fill="#ff9aa8" opacity="${opacity}"/>` +
           `<ellipse cx="127" cy="114" rx="9.5" ry="5" fill="#ff9aa8" opacity="${opacity}"/>`;
  }

  function sparkles() {
    const star = (x, y, r) =>
      `<path d="M ${x},${y - r} Q ${x + r * 0.22},${y - r * 0.22} ${x + r},${y} Q ${x + r * 0.22},${y + r * 0.22} ${x},${y + r} Q ${x - r * 0.22},${y + r * 0.22} ${x - r},${y} Q ${x - r * 0.22},${y - r * 0.22} ${x},${y - r} Z" fill="#ffd966"/>`;
    return star(34, 58, 8) + star(168, 76, 6) + star(48, 30, 5);
  }

  function teardrop() {
    return `<path d="M 134,116 Q 139,124 134,128 Q 129,124 134,116 Z" fill="#9fd3f0" opacity="0.9"/>`;
  }

  function sleepZ() {
    const z = (x, y, s) =>
      `<path d="M ${x},${y} h ${s} l ${-s},${s * 0.9} h ${s}" fill="none" stroke="#8fa6c8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    return z(158, 46, 9) + z(172, 32, 12);
  }

  function angerMark() {
    const seg = (x1, y1, x2, y2) =>
      `<path d="M ${x1},${y1} L ${x2},${y2}" stroke="#e87a8a" stroke-width="2.6" stroke-linecap="round"/>`;
    return seg(150, 52, 158, 60) + seg(158, 52, 150, 60) + seg(163, 44, 169, 50) + seg(169, 44, 163, 50);
  }

  // 表情ごとの組み立て
  function face(expr, eyeCol) {
    switch (expr) {
      case 'smile':
        return browsAt(88, 86) + eyeOpen(78, eyeCol) + eyeOpen(122, eyeCol) + MOUTH.smile + blushMarks(0.4);
      case 'joy':
        return browsAt(87, 85) + eyeHappy(78) + eyeHappy(122) + MOUTH.openJoy + blushMarks(0.5) + sparkles();
      case 'blush':
        return browsAt(87, 89) + eyeOpen(78, eyeCol, 2.5) + eyeOpen(122, eyeCol, 2.5) + MOUTH.wavy + blushMarks(0.95);
      case 'pout':
        return browsAt(93, 85, 3) + eyeOpen(78, eyeCol, -2.5) + eyeOpen(122, eyeCol, -2.5) + MOUTH.pout + blushMarks(0.45) + angerMark();
      case 'sad':
        return browsAt(85, 91) + eyeSadClosed(78) + eyeSadClosed(122) + MOUTH.frown + blushMarks(0.2) + teardrop();
      case 'surprised':
        return browsAt(84, 82) + eyeWide(78, eyeCol) + eyeWide(122, eyeCol) + MOUTH.o + blushMarks(0.3);
      case 'sleepy':
        return browsAt(89, 88) + eyeOpen(78, eyeCol, 0, 9) + eyeOpen(122, eyeCol, 0, 9) + MOUTH.tiny + blushMarks(0.25) + sleepZ();
      case 'normal':
      default:
        return browsAt(88, 86) + eyeOpen(78, eyeCol) + eyeOpen(122, eyeCol) + MOUTH.soft + blushMarks(0.3);
    }
  }

  // ── hair ──────────────────────────────────────────────────────────────────

  // 前髪(全スタイル共通のぱっつんスカラップ+トップのハイライト)
  function bangs(hair) {
    const line = shade(hair, -0.3);
    const hi = shade(hair, 0.22);
    return (
      `<path d="M 43,98 A 57 57 0 0 1 157,98 Q 152,92 140,79 Q 128,94 114,79 Q 100,96 86,79 Q 72,94 58,79 Q 48,91 43,98 Z"
         fill="${hair}" stroke="${line}" stroke-width="2.5" stroke-linejoin="round"/>` +
      `<path d="M 68,60 Q 92,44 116,52" fill="none" stroke="${hi}" stroke-width="5" stroke-linecap="round" opacity="0.85"/>`
    );
  }

  // 顔横のもみあげ(long / twintail / ponytail)
  function sideLocks(hair, len) {
    const line = shade(hair, -0.3);
    const lock = `<path d="M 45,86 Q 38,${86 + len * 0.55} 44,${86 + len} Q 50,${86 + len - 4} 52,${86 + len * 0.5} Q 54,104 56,92 Z"
        fill="${hair}" stroke="${line}" stroke-width="2.2" stroke-linejoin="round"/>`;
    return lock + `<g transform="translate(200,0) scale(-1,1)">${lock}</g>`;
  }

  // 後ろ髪(スタイル別、頭・体より背面に描く)
  function backHair(style, hair) {
    const line = shade(hair, -0.3);
    const P = (d) => `<path d="${d}" fill="${hair}" stroke="${line}" stroke-width="2.5" stroke-linejoin="round"/>`;
    switch (style) {
      case 'short':
        return P('M 43,92 A 58 55 0 0 1 157,92 Q 160,118 150,128 Q 145,110 142,104 L 58,104 Q 55,110 50,128 Q 40,118 43,92 Z');
      case 'bob':
        return P('M 42,92 A 59 56 0 0 1 158,92 Q 162,130 152,152 Q 144,160 138,150 L 62,150 Q 56,160 48,152 Q 38,130 42,92 Z');
      case 'long':
        return P('M 42,92 A 59 56 0 0 1 158,92 Q 165,150 162,200 Q 160,222 150,230 Q 144,218 140,226 Q 132,234 126,222 Q 118,234 110,224 L 90,224 Q 82,234 74,222 Q 68,234 60,226 Q 56,218 50,230 Q 40,222 38,200 Q 35,150 42,92 Z');
      case 'twintail': {
        const tail = `<path d="M 47,88 Q 14,120 22,180 Q 24,200 34,206 Q 42,200 40,184 Q 36,134 60,100 Z"
            fill="${hair}" stroke="${line}" stroke-width="2.5" stroke-linejoin="round"/>
          <ellipse cx="50" cy="86" rx="8" ry="7" fill="${shade(hair, -0.18)}" stroke="${line}" stroke-width="2"/>`;
        return P('M 43,92 A 58 55 0 0 1 157,92 Q 160,118 150,128 Q 145,110 142,104 L 58,104 Q 55,110 50,128 Q 40,118 43,92 Z') +
          tail + `<g transform="translate(200,0) scale(-1,1)">${tail}</g>`;
      }
      case 'ponytail':
        return P('M 43,92 A 58 55 0 0 1 157,92 Q 160,118 150,128 Q 145,110 142,104 L 58,104 Q 55,110 50,128 Q 40,118 43,92 Z') +
          P('M 138,52 Q 178,70 176,130 Q 175,170 160,196 Q 150,202 148,190 Q 158,150 152,110 Q 148,80 128,64 Z') +
          `<ellipse cx="139" cy="59" rx="8" ry="7" fill="${shade(hair, -0.18)}" stroke="${line}" stroke-width="2"/>`;
      default:
        return backHair('long', hair);
    }
  }

  // ── accessories ───────────────────────────────────────────────────────────

  function accessory(id) {
    switch (id) {
      case 'ribbon':
        return `<g transform="translate(62,50) rotate(-18)">
            <path d="M 0,0 Q -16,-10 -18,2 Q -16,12 0,6 Z" fill="#ff8fab" stroke="#d6577d" stroke-width="2" stroke-linejoin="round"/>
            <path d="M 0,0 Q 16,-12 19,0 Q 18,12 0,6 Z" fill="#ff8fab" stroke="#d6577d" stroke-width="2" stroke-linejoin="round"/>
            <circle cx="0" cy="3" r="5" fill="#ffb3c8" stroke="#d6577d" stroke-width="2"/>
          </g>`;
      case 'glasses':
        return `<g fill="none" stroke="#5a4a52" stroke-width="2.6">
            <rect x="64" y="89" width="29" height="22" rx="10"/>
            <rect x="107" y="89" width="29" height="22" rx="10"/>
            <path d="M 93,99 Q 100,95 107,99"/>
          </g>`;
      case 'flower':
        { const petal = (a) => `<ellipse cx="0" cy="-8" rx="5" ry="8" fill="#fff" stroke="#e8c46a" stroke-width="1.6" transform="rotate(${a})"/>`;
          return `<g transform="translate(140,54) scale(0.95)">
            ${petal(0)}${petal(72)}${petal(144)}${petal(216)}${petal(288)}
            <circle r="5" fill="#ffd166" stroke="#e8a93c" stroke-width="1.6"/>
          </g>`; }
      default:
        return '';
    }
  }

  // ── body ──────────────────────────────────────────────────────────────────

  function body(skin, outfit) {
    const skinLine = shade(skin, -0.3);
    const outfitDark = shade(outfit, -0.28);
    return (
      // 脚と靴
      `<path d="M 86,206 h 11 v 32 h -11 Z" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>` +
      `<path d="M 103,206 h 11 v 32 h -11 Z" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>` +
      `<ellipse cx="91" cy="241" rx="11" ry="7" fill="${outfitDark}"/>` +
      `<ellipse cx="109" cy="241" rx="11" ry="7" fill="${outfitDark}"/>` +
      // 首
      `<path d="M 93,134 h 14 v 16 h -14 Z" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>` +
      // ワンピース
      `<path d="M 79,150 Q 100,142 121,150 L 132,208 Q 100,218 68,208 Z"
         fill="${outfit}" stroke="${outfitDark}" stroke-width="2.5" stroke-linejoin="round"/>` +
      `<path d="M 70.5,196 Q 100,205 129.5,196" fill="none" stroke="${outfitDark}" stroke-width="2.2" opacity="0.7"/>` +
      // 襟と前立て
      `<path d="M 89,148 L 100,160 L 111,148 Q 100,143 89,148 Z" fill="#fffdf7" stroke="${outfitDark}" stroke-width="2" stroke-linejoin="round"/>` +
      `<circle cx="100" cy="170" r="2.4" fill="${outfitDark}"/>` +
      `<circle cx="100" cy="182" r="2.4" fill="${outfitDark}"/>` +
      // 腕(袖+手)
      `<path d="M 80,152 Q 66,168 64,192 Q 64,200 72,199 Q 80,180 86,166 Z" fill="${outfit}" stroke="${outfitDark}" stroke-width="2.4" stroke-linejoin="round"/>` +
      `<path d="M 120,152 Q 134,168 136,192 Q 136,200 128,199 Q 120,180 114,166 Z" fill="${outfit}" stroke="${outfitDark}" stroke-width="2.4" stroke-linejoin="round"/>` +
      `<circle cx="68" cy="200" r="6" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>` +
      `<circle cx="132" cy="200" r="6" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>`
    );
  }

  function head(skin) {
    const skinLine = shade(skin, -0.3);
    return `<ellipse cx="100" cy="95" rx="54" ry="50" fill="${skin}" stroke="${skinLine}" stroke-width="2.5"/>`;
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render(look, expression) {
    const lk = look || {};
    const hair   = safeColor(lk.hairColor,   DEFAULT_LOOK.hairColor);
    const eye    = safeColor(lk.eyeColor,    DEFAULT_LOOK.eyeColor);
    const skin   = safeColor(lk.skinTone,    DEFAULT_LOOK.skinTone);
    const outfit = safeColor(lk.outfitColor, DEFAULT_LOOK.outfitColor);
    const style  = HAIR_STYLES.some(h => h.id === lk.hairStyle) ? lk.hairStyle : DEFAULT_LOOK.hairStyle;
    const acc    = ACCESSORIES.some(a => a.id === lk.accessory) ? lk.accessory : 'none';
    const expr   = EXPRESSIONS.includes(expression) ? expression : 'normal';
    const hasSideLocks = style === 'long' || style === 'twintail' || style === 'ponytail';

    return `<svg viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg" class="chara-svg chara-expr-${expr}" role="img" aria-label="キャラクター">
      <g class="chara-figure">
        <animateTransform attributeName="transform" type="translate" values="0 0; 0 2.5; 0 0" dur="3.2s" repeatCount="indefinite"/>
        ${backHair(style, hair)}
        ${body(skin, outfit)}
        ${head(skin)}
        <g class="chara-face" fill="${skin}">${face(expr, eye)}</g>
        ${bangs(hair)}
        ${hasSideLocks ? sideLocks(hair, style === 'long' ? 70 : 52) : ''}
        ${accessory(acc)}
      </g>
    </svg>`;
  }

  window.CharacterArt = { HAIR_STYLES, ACCESSORIES, EXPRESSIONS, DEFAULT_LOOK, render };

})();
