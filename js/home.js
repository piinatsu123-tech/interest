'use strict';

/* home.js — ホーム画面・セリフ欄・きろく */

// ─── 表情 ─────────────────────────────────────────────────────
function getDefaultExpression() {
  const slot = getTimeSlot();
  // 差分があるキャラは、登録ぶんを巡回して固定にしない。
  // 夜・全完了の特別な顔は、その差分を登録しているときだけ優先する。
  if (hasExpressionVariants()) {
    if (slot === 'night' && hasVariant('sleepy')) return 'sleepy';
    return homeRestExpression();
  }
  if (slot === 'night') return 'sleepy';
  if (isEverythingDoneToday()) return 'smile';
  return 'normal';
}

// ─── セリフポップアップ (しばらく表示してから消える) ──────────────
const BUBBLE_DURATION = 8000; // 長めに表示
/**
 * セリフをポップアップ表示。speech は文字列 or {text, expr} オブジェクト。
 * fallbackExpr: speech.expr がないときに使う表情 (省略時は表情を変えない)。
 */
function showBubble(speech, fallbackExpr) {
  const text = (speech && typeof speech === 'object') ? speech.text : speech;
  const expr = (speech && typeof speech === 'object' && speech.expr) ? speech.expr : (fallbackExpr || null);
  const bubble = document.getElementById('home-bubble');
  const textEl = document.getElementById('home-bubble-text');
  if (!bubble || !textEl) return;
  textEl.textContent = text; // textContent で XSS 防止
  bubble.classList.remove('hidden');
  // 出るたびにポップアニメをやり直す
  bubble.style.animation = 'none';
  void bubble.offsetWidth;
  bubble.style.animation = '';
  // セリフに表情が指定されていれば反映
  if (expr) renderChara('home-chara', expr);
  // 一定時間で消し、表情も休憩中の顔に戻す
  clearTimeout(showBubble._timer);
  showBubble._timer = setTimeout(() => {
    bubble.classList.add('hidden');
    renderChara('home-chara', _homeRestExpr);
  }, BUBBLE_DURATION);
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

  // 立ち絵 (休憩中の顔。ポップアップが消えたらここへ戻す)
  _homeRestExpr = getDefaultExpression();
  renderChara('home-chara', _homeRestExpr);

  // セリフ
  let situation;
  if (comeback) {
    situation = 'comeback';
  } else {
    // 夕方以降に「今日のタスク」がまだ片付いていない (= must が残っている)
    const slot = getTimeSlot();
    const hasOverdue = (slot === 'evening' || slot === 'night')
      && !isEverythingDoneToday()
      && ffActiveTasks().some(t => !t.done);

    if (hasOverdue) {
      situation = 'has_overdue';
      _homeRestExpr = 'pout'; // 督促中はしょんぼり顔のままにする
      renderChara('home-chara', 'pout');
    } else {
      situation = getGreetingSituation();
    }
  }
  const speech = getSpeech(situation);
  _lastBubbleText = speech.text;
  showBubble(speech);
  _lastGreetSlotId = currentTimeSlot().id;

  // タスクランチャーの残数
  refreshHomeLauncher();
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

/** タスクランチャーの残数サマリーを更新 */
function refreshHomeLauncher() {
  const el = document.getElementById('home-task-summary');
  if (!el) return;
  const remaining = ffActiveTasks().filter(t => !t.done).length;
  el.textContent = remaining === 0
    ? '今日のタスクは全部おわり！'
    : `のこり ${remaining} 件`;
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
