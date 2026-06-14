'use strict';

/* CharacterArt — パーツ合成式のデフォルメ立ち絵 SVG レンダラー
   契約は DESIGN.md を参照。render() は SVG マークアップ文字列を返す。 */

(function () {

  const HAIR_STYLES = [
    { id: 'short',    name: 'ショート' },
    { id: 'pixie',    name: 'ベリーショート' },
    { id: 'bob',      name: 'ボブ' },
    { id: 'long',     name: 'ロング' },
    { id: 'wavy',     name: 'ウェーブ' },
    { id: 'hime',     name: '姫カット' },
    { id: 'twintail', name: 'ツインテール' },
    { id: 'ponytail', name: 'ポニーテール' },
    { id: 'buns',     name: 'おだんご' },
    { id: 'braids',   name: 'みつあみ' },
  ];

  const ACCESSORIES = [
    { id: 'none',    name: 'なし' },
    { id: 'ribbon',  name: 'リボン' },
    { id: 'glasses', name: 'メガネ' },
    { id: 'flower',  name: 'お花' },
    { id: 'catears', name: 'ねこみみ' },
    { id: 'hairpin', name: 'ヘアピン' },
    { id: 'beret',   name: 'ベレー帽' },
    { id: 'earring', name: 'イヤリング' },
  ];

  const OUTFIT_STYLES = [
    { id: 'dress',  name: 'ワンピース' },
    { id: 'hoodie', name: 'パーカー' },
    { id: 'sailor', name: 'セーラー服' },
    { id: 'blazer', name: 'ジャケット' },
    { id: 'yukata', name: 'ゆかた' },
  ];

  const EXPRESSIONS = ['normal', 'smile', 'joy', 'blush', 'pout', 'sad', 'surprised', 'sleepy'];

  const DEFAULT_LOOK = {
    hairStyle: 'long',
    hairColor: '#6b4f3a',
    eyeColor: '#4a6fa5',
    skinTone: '#ffe3cf',
    outfitColor: '#e8718d',
    outfitStyle: 'dress',
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
      case 'pixie':
        // 頭にぴったり沿う刈り上げ気味ショート
        return P('M 45,90 A 56 53 0 0 1 155,90 Q 157,108 149,116 Q 146,104 143,100 L 57,100 Q 54,104 51,116 Q 43,108 45,90 Z');
      case 'wavy': {
        // ロングの裾を S カーブで波打たせる
        return P('M 42,92 A 59 56 0 0 1 158,92 Q 168,140 164,180 Q 170,196 160,206 Q 168,220 154,228 Q 158,238 144,236 Q 134,230 138,220 Q 128,228 124,216 L 76,216 Q 72,228 62,220 Q 66,230 56,236 Q 42,238 46,228 Q 32,220 40,206 Q 30,196 36,180 Q 32,140 42,92 Z');
      }
      case 'hime':
        // 真っ直ぐ切り揃えた後ろ髪 (裾は水平)
        return P('M 42,92 A 59 56 0 0 1 158,92 Q 164,150 163,210 L 37,210 Q 36,150 42,92 Z') +
          `<path d="M 50,206 L 150,206" stroke="${line}" stroke-width="2" opacity="0.5"/>`;
      case 'buns': {
        // ショートベース+左右のおだんご
        const bun = `<circle cx="52" cy="44" r="15" fill="${hair}" stroke="${line}" stroke-width="2.5"/>
          <path d="M 42,38 Q 52,30 62,38" fill="none" stroke="${shade(hair, 0.22)}" stroke-width="3" stroke-linecap="round" opacity="0.85"/>
          <ellipse cx="52" cy="56" rx="6" ry="4" fill="${shade(hair, -0.18)}" stroke="${line}" stroke-width="1.8"/>`;
        return bun + `<g transform="translate(200,0) scale(-1,1)">${bun}</g>` +
          P('M 43,92 A 58 55 0 0 1 157,92 Q 160,118 150,128 Q 145,110 142,104 L 58,104 Q 55,110 50,128 Q 40,118 43,92 Z');
      }
      case 'braids': {
        // ボブベース+左右の三つ編み (玉が連なる表現)
        const ball = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${hair}" stroke="${line}" stroke-width="2.2"/>`;
        const braid = ball(47, 124, 10) + ball(43, 144, 9) + ball(46, 163, 8) + ball(43, 180, 7) +
          `<path d="M 43,187 Q 41,198 46,202 Q 50,196 48,187 Z" fill="${hair}" stroke="${line}" stroke-width="2"/>` +
          `<ellipse cx="44" cy="186" rx="5" ry="3.5" fill="${shade(hair, -0.18)}" stroke="${line}" stroke-width="1.6"/>`;
        return P('M 42,92 A 59 56 0 0 1 158,92 Q 162,124 152,140 Q 144,148 138,140 L 62,140 Q 56,148 48,140 Q 38,124 42,92 Z') +
          braid + `<g transform="translate(200,0) scale(-1,1)">${braid}</g>`;
      }
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
      case 'catears': {
        const ear = `<g transform="translate(60,40) rotate(-12)">
            <path d="M 0,14 L 9,-14 L 20,10 Z" fill="#4a3b40" stroke="#332026" stroke-width="2" stroke-linejoin="round"/>
            <path d="M 5,9 L 10,-5 L 15,7 Z" fill="#ff9aa8"/>
          </g>`;
        return ear + `<g transform="translate(200,0) scale(-1,1)">${ear}</g>`;
      }
      case 'hairpin':
        return `<g transform="translate(64,64) rotate(-20)" stroke="#e8b93c" stroke-width="3.4" stroke-linecap="round">
            <path d="M 0,0 L 18,0"/>
            <path d="M 2,6 L 20,6"/>
          </g>`;
      case 'beret':
        return `<g>
            <path d="M 40,58 Q 42,26 100,22 Q 158,26 160,58 Q 130,46 100,46 Q 70,46 40,58 Z"
              fill="#c0392b" stroke="#8e2820" stroke-width="2.5" stroke-linejoin="round"/>
            <circle cx="100" cy="22" r="4.5" fill="#8e2820"/>
          </g>`;
      case 'earring': {
        const ring = `<circle cx="47" cy="116" r="3" fill="#ffd166" stroke="#e8a93c" stroke-width="1.5"/>
          <circle cx="47" cy="123" r="4.5" fill="none" stroke="#ffd166" stroke-width="2.4"/>`;
        return ring + `<g transform="translate(200,0) scale(-1,1)">${ring}</g>`;
      }
      default:
        return '';
    }
  }

  // ── body ──────────────────────────────────────────────────────────────────

  function body(skin, outfit, outfitStyle) {
    const skinLine = shade(skin, -0.3);
    const outfitDark = shade(outfit, -0.28);
    const outfitLight = shade(outfit, 0.25);

    // 共通: 脚・靴・首
    const legs =
      `<path d="M 86,206 h 11 v 32 h -11 Z" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>` +
      `<path d="M 103,206 h 11 v 32 h -11 Z" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>` +
      `<ellipse cx="91" cy="241" rx="11" ry="7" fill="${outfitDark}"/>` +
      `<ellipse cx="109" cy="241" rx="11" ry="7" fill="${outfitDark}"/>`;
    const neck = `<path d="M 93,134 h 14 v 16 h -14 Z" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>`;
    // 共通: 腕(袖+手)。色を変えられるよう関数に
    const arms = (sleeve) =>
      `<path d="M 80,152 Q 66,168 64,192 Q 64,200 72,199 Q 80,180 86,166 Z" fill="${sleeve}" stroke="${shade(sleeve, -0.28)}" stroke-width="2.4" stroke-linejoin="round"/>` +
      `<path d="M 120,152 Q 134,168 136,192 Q 136,200 128,199 Q 120,180 114,166 Z" fill="${sleeve}" stroke="${shade(sleeve, -0.28)}" stroke-width="2.4" stroke-linejoin="round"/>` +
      `<circle cx="68" cy="200" r="6" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>` +
      `<circle cx="132" cy="200" r="6" fill="${skin}" stroke="${skinLine}" stroke-width="2"/>`;
    const WHITE = '#fffdf7';

    switch (outfitStyle) {
      case 'hoodie':
        return legs + neck +
          // フード (首の後ろ)
          `<path d="M 76,152 Q 100,168 124,152 Q 124,140 100,138 Q 76,140 76,152 Z" fill="${outfitDark}" stroke="${shade(outfit, -0.45)}" stroke-width="2.2" stroke-linejoin="round"/>` +
          // 胴 (箱形)
          `<path d="M 76,150 Q 100,144 124,150 L 130,210 Q 100,217 70,210 Z" fill="${outfit}" stroke="${outfitDark}" stroke-width="2.5" stroke-linejoin="round"/>` +
          // カンガルーポケット
          `<path d="M 84,184 L 116,184 L 112,204 L 88,204 Z" fill="${outfitLight}" stroke="${outfitDark}" stroke-width="2" stroke-linejoin="round"/>` +
          // ドローコード
          `<path d="M 93,152 L 92,164 M 107,152 L 108,164" stroke="${WHITE}" stroke-width="2.4" stroke-linecap="round"/>` +
          `<circle cx="92" cy="166" r="2" fill="${WHITE}"/><circle cx="108" cy="166" r="2" fill="${WHITE}"/>` +
          arms(outfit);
      case 'sailor':
        return legs + neck +
          // 白いトップス
          `<path d="M 78,150 Q 100,143 122,150 L 126,192 Q 100,199 74,192 Z" fill="${WHITE}" stroke="#c8bfae" stroke-width="2.4" stroke-linejoin="round"/>` +
          // セーラーカラー
          `<path d="M 84,147 L 100,168 L 116,147 L 121,158 L 100,176 L 79,158 Z" fill="${outfit}" stroke="${outfitDark}" stroke-width="2.2" stroke-linejoin="round"/>` +
          `<path d="M 96,170 L 100,180 L 104,170 Q 100,167 96,170 Z" fill="${outfitDark}"/>` +
          // プリーツスカート
          `<path d="M 76,190 Q 100,197 124,190 L 132,214 Q 100,223 68,214 Z" fill="${outfit}" stroke="${outfitDark}" stroke-width="2.4" stroke-linejoin="round"/>` +
          `<path d="M 86,193 L 82,212 M 100,196 L 100,217 M 114,193 L 118,212" fill="none" stroke="${outfitDark}" stroke-width="1.8" opacity="0.7"/>` +
          arms(WHITE);
      case 'blazer':
        return legs + neck +
          // シャツ+ネクタイ
          `<path d="M 86,148 L 100,162 L 114,148 L 114,196 L 86,196 Z" fill="${WHITE}" stroke="#c8bfae" stroke-width="2"/>` +
          `<path d="M 97,158 L 100,176 L 103,158 L 100,154 Z" fill="${outfitDark}"/>` +
          // ジャケット
          `<path d="M 78,150 Q 88,145 92,148 L 88,208 L 72,206 Z" fill="${outfit}" stroke="${outfitDark}" stroke-width="2.4" stroke-linejoin="round"/>` +
          `<path d="M 122,150 Q 112,145 108,148 L 112,208 L 128,206 Z" fill="${outfit}" stroke="${outfitDark}" stroke-width="2.4" stroke-linejoin="round"/>` +
          // 襟 (ラペル)
          `<path d="M 92,148 L 100,162 L 88,166 Z" fill="${outfitLight}" stroke="${outfitDark}" stroke-width="1.8" stroke-linejoin="round"/>` +
          `<path d="M 108,148 L 100,162 L 112,166 Z" fill="${outfitLight}" stroke="${outfitDark}" stroke-width="1.8" stroke-linejoin="round"/>` +
          // スカート
          `<path d="M 80,196 Q 100,202 120,196 L 126,212 Q 100,220 74,212 Z" fill="${shade(outfit, -0.4)}" stroke="${shade(outfit, -0.55)}" stroke-width="2.2" stroke-linejoin="round"/>` +
          arms(outfit);
      case 'yukata':
        return legs + neck +
          // 着物の身頃 (Aライン・長め)
          `<path d="M 80,150 Q 100,142 120,150 L 136,228 Q 100,236 64,228 Z" fill="${outfit}" stroke="${outfitDark}" stroke-width="2.5" stroke-linejoin="round"/>` +
          // 衿合わせ
          `<path d="M 100,158 L 86,148 Q 96,143 100,146 Z" fill="${WHITE}" stroke="${outfitDark}" stroke-width="1.8" stroke-linejoin="round"/>` +
          `<path d="M 100,146 Q 104,143 114,148 L 100,170 Z" fill="${outfitLight}" stroke="${outfitDark}" stroke-width="1.8" stroke-linejoin="round"/>` +
          // 帯
          `<path d="M 74,178 Q 100,186 126,178 L 127,192 Q 100,200 73,192 Z" fill="${shade(outfit, -0.5)}" stroke="${shade(outfit, -0.62)}" stroke-width="2.2" stroke-linejoin="round"/>` +
          `<path d="M 90,182 L 110,188" stroke="${outfitLight}" stroke-width="2.4" stroke-linecap="round" opacity="0.85"/>` +
          // 小花柄
          `<circle cx="88" cy="164" r="2.2" fill="${outfitLight}" opacity="0.9"/>` +
          `<circle cx="114" cy="208" r="2.2" fill="${outfitLight}" opacity="0.9"/>` +
          `<circle cx="84" cy="214" r="2.2" fill="${outfitLight}" opacity="0.9"/>` +
          arms(outfit);
      case 'dress':
      default:
        return legs + neck +
          // ワンピース
          `<path d="M 79,150 Q 100,142 121,150 L 132,208 Q 100,218 68,208 Z"
             fill="${outfit}" stroke="${outfitDark}" stroke-width="2.5" stroke-linejoin="round"/>` +
          `<path d="M 70.5,196 Q 100,205 129.5,196" fill="none" stroke="${outfitDark}" stroke-width="2.2" opacity="0.7"/>` +
          // 襟と前立て
          `<path d="M 89,148 L 100,160 L 111,148 Q 100,143 89,148 Z" fill="${WHITE}" stroke="${outfitDark}" stroke-width="2" stroke-linejoin="round"/>` +
          `<circle cx="100" cy="170" r="2.4" fill="${outfitDark}"/>` +
          `<circle cx="100" cy="182" r="2.4" fill="${outfitDark}"/>` +
          arms(outfit);
    }
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
    const ofs    = OUTFIT_STYLES.some(o => o.id === lk.outfitStyle) ? lk.outfitStyle : DEFAULT_LOOK.outfitStyle;
    const expr   = EXPRESSIONS.includes(expression) ? expression : 'normal';
    const hasSideLocks = ['long', 'twintail', 'ponytail', 'wavy', 'hime'].includes(style);

    return `<svg viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg" class="chara-svg chara-expr-${expr}" role="img" aria-label="キャラクター">
      <g class="chara-figure">
        <animateTransform attributeName="transform" type="translate" values="0 0; 0 2.5; 0 0" dur="3.2s" repeatCount="indefinite"/>
        ${backHair(style, hair)}
        ${body(skin, outfit, ofs)}
        ${head(skin)}
        <g class="chara-face" fill="${skin}">${face(expr, eye)}</g>
        ${bangs(hair)}
        ${hasSideLocks ? sideLocks(hair, (style === 'long' || style === 'wavy' || style === 'hime') ? 70 : 52) : ''}
        ${accessory(acc)}
      </g>
    </svg>`;
  }

  window.CharacterArt = { HAIR_STYLES, ACCESSORIES, OUTFIT_STYLES, EXPRESSIONS, DEFAULT_LOOK, render };

})();
