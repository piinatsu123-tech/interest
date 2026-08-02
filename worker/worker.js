const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const btn = (label, text) => ({ type: 'action', action: { type: 'message', label, text: text || label } });
const QR_DEFAULT   = { items: [btn('一覧'), btn('定期一覧'), btn('ヘルプ')] };
const QR_TASK      = { items: [btn('一覧'), btn('定期一覧'), btn('定期登録'), btn('ヘルプ')] };
const QR_RECURRING = { items: [btn('定期登録'), btn('定期削除'), btn('一覧')] };
const QR_AFTER_REG = { items: [btn('定期一覧'), btn('一覧'), btn('ヘルプ')] };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (request.method === 'GET' && url.pathname === '/tasks') {
      const tasks = await env.TASKS.get('pending', { type: 'json' }) || [];
      return new Response(JSON.stringify(tasks), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    if (request.method === 'DELETE' && url.pathname === '/tasks') {
      await env.TASKS.put('pending', JSON.stringify([]));
      return new Response('OK', { headers: CORS });
    }
    if (request.method === 'POST' && url.pathname === '/sync') {
      const body = await request.json().catch(() => ({}));
      await env.TASKS.put('active_tasks', JSON.stringify(body.tasks || []));
      return new Response('OK', { headers: CORS });
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      // シークレットが欠けていると、署名検証で例外を吐くか返信送信で TypeError に
      // なり、「LINE が無反応・ログも出ない」という原因不明の壊れ方をする。
      // (平文の Variable は wrangler deploy で消えるため実際に起きた)
      // 先に検出してログと HTTP 500 で知らせる。
      const missing = missingSecrets(env);
      if (missing.length) {
        console.error('[FATAL] シークレットが未設定:', missing.join(', '),
          '→ Cloudflare の Settings → Variables and Secrets に「Secret」種別で登録してください');
        return new Response('Missing secrets: ' + missing.join(', '), { status: 500 });
      }
      const body = await request.text();
      const signature = request.headers.get('x-line-signature');
      if (!await verifySignature(body, signature, env.LINE_CHANNEL_SECRET)) {
        console.error('[ERROR] 署名検証に失敗。LINE_CHANNEL_SECRET が正しいか確認してください');
        return new Response('Unauthorized', { status: 401 });
      }
      const data = JSON.parse(body);
      for (const event of data.events || []) {
        if (event.type !== 'message') continue;
        // ユーザーIDをキャプチャ（プッシュ通知用）
        if (event.source?.userId) {
          ctx.waitUntil(env.TASKS.put('line_user_id', event.source.userId));
        }
        // catch を付けないと waitUntil 内の例外が握り潰されて無言で失敗する
        ctx.waitUntil(handleMessage(event, env).catch(e => {
          console.error('[ERROR] handleMessage 失敗:', e && (e.stack || e.message || e));
        }));
      }
      return new Response('OK');
    }
    return new Response('Not found', { status: 404 });
  },

  // Cron：毎朝6時JST（21:00 UTC）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMorningCron(env).catch(e => {
      console.error('[ERROR] 朝のCron失敗:', e && (e.stack || e.message || e));
    }));
  }
};

// ─── シークレットの検証 ──────────────────────────────────────────
// wrangler deploy は wrangler.toml に無い「平文の Variable」を削除する。
// 3つとも「Secret」(暗号化) として登録してあればデプロイでは消えない。
const REQUIRED_SECRETS = ['ANTHROPIC_API_KEY', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'];

function missingSecrets(env) {
  return REQUIRED_SECRETS.filter(k => !env[k]);
}

// ─── 朝のCron処理 ────────────────────────────────────────────────
async function runMorningCron(env) {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = jstDateStr(now);
  await processRecurringTasks(env, now, todayStr);
  await sendMorningNotification(env, todayStr, []);
}

// ─── 定期タスク処理 ──────────────────────────────────────────────
async function processRecurringTasks(env, now, todayStr) {
  const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
  if (!list.length) return;
  let changed = false;
  const toAdd = [];
  for (const r of list) {
    if (matchesSchedule(r.schedule, now, r.lastAdded)) {
      toAdd.push(r);
      r.lastAdded = todayStr;
      changed = true;
    }
  }
  if (changed) await env.TASKS.put('recurring', JSON.stringify(list));
  if (!toAdd.length) return;
  const newTasks = toAdd.map(r => ({
    id: `rec_${r.id}_${todayStr}`,
    title: r.title, urgency: r.urgency || 'want',
    steps: [], done: false, createdAt: new Date().toISOString()
  }));
  const pending = await env.TASKS.get('pending', { type: 'json' }) || [];
  await env.TASKS.put('pending', JSON.stringify([...pending, ...newTasks]));
}

// ─── LINE朝の通知 ────────────────────────────────────────────────
async function sendMorningNotification(env, todayStr) {
  const userId = await env.TASKS.get('line_user_id');
  if (!userId) return;

  const activeTasks = await env.TASKS.get('active_tasks', { type: 'json' }) || [];
  const todayScheduled = activeTasks.filter(t =>
    !t.done && t.urgency === 'scheduled' && t.scheduledDate === todayStr
  );
  if (!todayScheduled.length) return;

  const lines = [
    '🔔 今日が実行日のタスクがあります：',
    ...todayScheduled.map(t => `・${t.title}`),
    '',
    'FocusFlowを開くと「今日中に絶対」に移動されます！'
  ];
  await pushToLine(userId, lines.join('\n'), env);
}

// ─── LINEメッセージ処理 ──────────────────────────────────────────
async function handleMessage(event, env) {
  const replyToken = event.replyToken;
  if (event.message.type !== 'text' && event.message.type !== 'image') return;
  const text = event.message.type === 'text' ? event.message.text.trim() : null;
  console.log('[受信]', event.message.type, text ? JSON.stringify(text.slice(0, 50)) : '');

  if (text === '一覧' || text === 'タスク一覧') return handleTaskList(replyToken, env);
  if (text === '定期一覧') return handleRecurringList(replyToken, env);
  if (text?.startsWith('定期登録 ')) return handleRecurringAdd(replyToken, text, env);
  if (text?.startsWith('定期削除 ')) return handleRecurringDelete(replyToken, text, env);
  if (text?.startsWith('休日登録 ')) return handleHolidayAdd(replyToken, text, env);
  if (text?.startsWith('休日削除 ')) return handleHolidayDelete(replyToken, text, env);
  if (text === '休日一覧') return handleHolidayList(replyToken, env);
  if (text === 'ヘルプ' || text === 'help') return replyToLine(replyToken, HELP_OVERVIEW, HELP_QR, env);
  if (text === 'ヘルプ：タスク') return replyToLine(replyToken, HELP_TASK, { items: [btn('ヘルプ：定期'), btn('ヘルプ：休日'), btn('ヘルプ：コマンド')] }, env);
  if (text === 'ヘルプ：定期') return replyToLine(replyToken, HELP_RECURRING, { items: [btn('ヘルプ：タスク'), btn('ヘルプ：休日'), btn('ヘルプ：コマンド')] }, env);
  if (text === 'ヘルプ：休日') return replyToLine(replyToken, HELP_HOLIDAY, { items: [btn('休日登録'), btn('休日一覧'), btn('ヘルプ：コマンド')] }, env);
  if (text === 'ヘルプ：コマンド') return replyToLine(replyToken, HELP_COMMANDS, { items: [btn('一覧'), btn('定期一覧'), btn('休日一覧')] }, env);
  if (text === '定期登録') {
    return replyToLine(replyToken,
      '定期タスクの登録形式：\n定期登録 スケジュール タスク名\n\n例）\n定期登録 毎日 薬を飲む\n定期登録 毎週月曜 燃えるゴミを出す\n定期登録 毎月1日 家賃を確認する\n定期登録 3日ごと 掃除機をかける',
      QR_RECURRING, env);
  }
  if (text === '定期削除') {
    const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
    const listText = list.length ? '\n\n登録中のタスク：\n' + list.map(r => `・${r.title}`).join('\n') : '';
    return replyToLine(replyToken, `削除形式：\n定期削除 タスク名${listText}`, QR_RECURRING, env);
  }

  // 汚れの記録。「記録！〜」で始まるものはタスクにせず記録だけ残す(Claude を呼ばない)
  if (text === '記録一覧') return handleDirtList(replyToken, env);
  if (text && DIRT_PREFIX_RE.test(text)) return handleDirtLog(replyToken, text, env);

  // 「写真:」プレフィックス → キャッシュして終了（タスク登録しない）
  if (event.message.type === 'text' && text?.startsWith('写真:') && event.source?.userId) {
    const instruction = text.replace(/^写真[:：]\s*/, '').trim();
    await env.TASKS.put(
      `text_ctx_${event.source.userId}`,
      JSON.stringify({ text: instruction, timestamp: Date.now() }),
      { expirationTtl: 120 }
    );
    return replyToLine(replyToken,
      `📷 指示を受け取りました：「${instruction}」\n60秒以内に写真を送ってください。`,
      { items: [btn('ヘルプ')] }, env);
  }

  // 通常タスク追加（Claude API）
  let userContent;
  if (event.message.type === 'text') {
    userContent = [{ type: 'text', text }];
  } else {
    const imageRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN.replace(/\s/g, '')}` } }
    );
    const imageData = await imageRes.arrayBuffer();
    const uint8 = new Uint8Array(imageData);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    const base64 = btoa(binary);

    // 「写真:」で事前に送られた指示があれば使う
    let instruction = 'この画像を見て、対処すべきことをタスクに分解してください。';
    if (event.source?.userId) {
      const cached = await env.TASKS.get(`text_ctx_${event.source.userId}`, { type: 'json' });
      if (cached && Date.now() - cached.timestamp < 60000) {
        instruction = `${cached.text}\n\nこの指示に基づいて、この画像を見てタスクに分解してください。`;
        await env.TASKS.delete(`text_ctx_${event.source.userId}`);
      }
    }
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
      { type: 'text', text: instruction }
    ];
  }

  const today = jstDateStr();
  const holidays = await env.TASKS.get('holidays', { type: 'json' }) || [];
  const futureHolidays = holidays.filter(d => d >= today).sort();
  const holidayPrompt = futureHolidays.length
    ? `\n## 休日リスト\n${futureHolidays.map((d, i) => `・${i === 0 ? '次の休み' : i === 1 ? '次の次の休み' : `${i+1}番目の休み`}：${d}`).join('\n')}\n「次の休み」「次の次の休み」は上記の日付をscheduledDateに使う。`
    : '';

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      system: `role:タスク管理AI|out:JSONのみ・前置き不要|date:${today}${holidayPrompt}
title:ユーザーが書いた言葉をそのまま使う。別のタスクに置き換えない
task_n:原則1件。「AとBとCのX」のAとBとCはXの修飾であってタスクの列挙ではない→"X"1件にする。述語(最後の動詞)が何を求めているかで判断。動詞が複数あり明確に別件の時だけ複数件
思考タスク:"考える/決める/計画/設計/検討/見直す"はその思考作業自体が1タスク。中身を実行タスクに展開するのは禁止(まだやると決まっていないため)。stepは思考の進め方にする
 ex:"AとBとCのスケジュールを考える"→✗"Aを実施","Bを追加","Cを暗記"の3タスク化
  ✓"スケジュールを考える"1件|step:"紙とペンを出す","A/B/Cそれぞれの所要時間を書き出す","今週の空き時間を確認する","カレンダーに書き込む"
step:1step=「完了の瞬間の写真が撮れる」単一動作(=終了後にモノがどこにあるか一意に決まる)|着点必須(何を+どこへ)|5分以内|数は必要なだけ(目安5〜12)
禁止語:用意/準備/セット/対応/処理/整理/まとめる/済ませる ←状態語であって動作ではない
着点を補え:出す→"棚から手に取る"|しまう/戻す/片付ける→"〜に入れる","〜に置く"
OK動詞:〜まで行く/手に取る/掴む/持つ/〜に置く/〜に入れる/開ける/閉める/押す/運ぶ/拭く/洗う/アプリを開く/入力する/送信ボタンを押す
必ず入れる(物理作業のみ。思考タスクには不要):移動"〜まで行く"|入手"〜を手に取る"|本作業|後始末"〜に入れる/置く/捨てる"
ex:床を清掃する→"掃除機のところまで行く","掃除機を手に取る","掃除機をかける","掃除機を元の場所に置く","雑巾の棚まで行く","棚から雑巾を手に取る","床を拭く","雑巾を洗濯かごに入れる"
ex:メールを送る→"アプリを開く","本文を入力する","送信ボタンを押す"
check:各stepの前に隠れた「行く/開く/手に取る」、後に「戻す/捨てる」は?
urgency:must=今日中|want=近いうち|nice=できれば|scheduled=特定日指定(scheduledDate必須)
trigger:「〜日にやる」「次の休みに」→scheduled|「〜日まで」→dueDate
RULE:scheduledDateが今日より未来の場合はurgencyを必ずscheduledにする・mustやwantにしてはいけない
field:dueDate=締切|scheduledDate=実行予定日|該当なければ省略
fmt:{"tasks":[{"id":"task_1","title":"","urgency":"must","dueDate":"YYYY-MM-DD","scheduledDate":"YYYY-MM-DD","steps":[{"id":"step_1","title":"","estimatedMinutes":5,"done":false}]}]}`,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!claudeRes.ok) {
    console.error('[ERROR] Claude API', claudeRes.status, (await claudeRes.text()).slice(0, 300));
    await replyToLine(replyToken, '処理できませんでした。もう一度送ってみてください。', QR_DEFAULT, env);
    return;
  }
  const claudeData = await claudeRes.json();
  const jsonText = claudeData.content[0].text.replace(/```json|```/g, '').trim();
  let newTasks;
  try { newTasks = JSON.parse(jsonText).tasks || []; }
  catch {
    await replyToLine(replyToken, '処理できませんでした。もう一度送ってみてください。', QR_DEFAULT, env);
    return;
  }

  // 全タスクをpendingに追加（scheduledも含む）
  const existing = await env.TASKS.get('pending', { type: 'json' }) || [];
  await env.TASKS.put('pending', JSON.stringify([...existing, ...newTasks]));

  const todayTasks = newTasks.filter(t => t.urgency !== 'scheduled');
  const futureTasks = newTasks.filter(t => t.urgency === 'scheduled');

  let replyMsg = '';
  if (todayTasks.length) {
    replyMsg += `✅ 追加しました！\n${todayTasks.map(t => `・${t.title}`).join('\n')}`;
  }
  if (futureTasks.length) {
    if (replyMsg) replyMsg += '\n\n';
    replyMsg += `📅 後日実行予定に追加しました\n${futureTasks.map(t => `・${t.title}（${t.scheduledDate}）`).join('\n')}`;
  }

  await replyToLine(replyToken, replyMsg, QR_TASK, env);
}

// ─── コマンド：タスク一覧 ────────────────────────────────────────
async function handleTaskList(replyToken, env) {
  const tasks = await env.TASKS.get('active_tasks', { type: 'json' }) || [];
  const active = tasks.filter(t => !t.done);
  if (!active.length) return replyToLine(replyToken, '現在のタスクはありません。', QR_DEFAULT, env);

  const groups = { must: [], want: [], nice: [], scheduled: [] };
  active.forEach(t => (groups[t.urgency] || groups.want).push(
    t.urgency === 'scheduled' && t.scheduledDate ? `${t.title}（${t.scheduledDate}）` : t.title
  ));
  const labels = { must: '今日中に絶対', want: 'できたらやりたい', nice: '余力があれば', scheduled: '後日実行予定' };
  let msg = '📋 現在のタスク一覧\n';
  for (const [key, label] of Object.entries(labels)) {
    if (groups[key].length) msg += `\n【${label}】\n` + groups[key].map(t => `・${t}`).join('\n') + '\n';
  }
  await replyToLine(replyToken, msg.trim(), QR_DEFAULT, env);
}

// ─── コマンド：定期タスク管理 ────────────────────────────────────
async function handleRecurringList(replyToken, env) {
  const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
  if (!list.length) return replyToLine(replyToken,
    '定期タスクはまだ登録されていません。\n\n「定期登録」をタップして登録できます。',
    { items: [btn('定期登録'), btn('ヘルプ')] }, env);
  const msg = '🔁 定期タスク一覧\n\n' + list.map(r => `・${r.schedule}　${r.title}`).join('\n');
  await replyToLine(replyToken, msg, QR_RECURRING, env);
}

async function handleRecurringAdd(replyToken, text, env) {
  const parts = text.replace('定期登録 ', '').trim().split(' ');
  if (parts.length < 2) return replyToLine(replyToken,
    '形式：定期登録 スケジュール タスク名\n例：定期登録 3日ごと 掃除機をかける', QR_RECURRING, env);
  const schedule = parts[0];
  const title = parts.slice(1).join(' ');
  if (!isValidSchedule(schedule)) return replyToLine(replyToken,
    `スケジュールの形式が正しくありません。\n使える形式：\n・毎日\n・毎週月曜\n・毎月1日\n・3日ごと / 3日に1回 / 毎3日`, QR_RECURRING, env);
  const today = jstDateStr();
  const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
  list.push({ id: `rec_${Date.now()}`, title, schedule, urgency: 'want', lastAdded: today });
  await env.TASKS.put('recurring', JSON.stringify(list));
  await replyToLine(replyToken, `✅ 定期タスクを登録しました\n「${title}」（${schedule}）`, QR_AFTER_REG, env);
}

async function handleRecurringDelete(replyToken, text, env) {
  const title = text.replace('定期削除 ', '').trim();
  const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
  const newList = list.filter(r => r.title !== title);
  if (newList.length === list.length) return replyToLine(replyToken,
    `「${title}」は見つかりませんでした。「定期一覧」で確認できます。`, QR_RECURRING, env);
  await env.TASKS.put('recurring', JSON.stringify(newList));
  await replyToLine(replyToken, `🗑 「${title}」を定期タスクから削除しました。`, QR_AFTER_REG, env);
}

// ─── コマンド：休日管理 ──────────────────────────────────────────
async function handleHolidayAdd(replyToken, text, env) {
  const parts = text.replace('休日登録 ', '').trim().split(/[\s、,]+/);
  const today = jstDateStr();
  const added = [];
  const errors = [];
  for (const p of parts) {
    const d = parseHolidayDate(p, today);
    if (d) added.push(d);
    else errors.push(p);
  }
  if (!added.length) return replyToLine(replyToken,
    `日付の形式が正しくありません。\n例：休日登録 5/19 5/23 5/27`, QR_DEFAULT, env);
  const existing = await env.TASKS.get('holidays', { type: 'json' }) || [];
  const merged = [...new Set([...existing, ...added])].sort();
  await env.TASKS.put('holidays', JSON.stringify(merged));
  const days = ['日','月','火','水','木','金','土'];
  const labels = added.map(d => { const dt = new Date(d+'T00:00:00'); return `・${dt.getMonth()+1}/${dt.getDate()}（${days[dt.getDay()]}）`; });
  let msg = `✅ 休日を登録しました（${added.length}件）\n${labels.join('\n')}`;
  if (errors.length) msg += `\n\n⚠️ 認識できなかった日付：${errors.join(', ')}`;
  await replyToLine(replyToken, msg, { items: [btn('休日一覧'), btn('一覧')] }, env);
}

async function handleHolidayList(replyToken, env) {
  const holidays = await env.TASKS.get('holidays', { type: 'json' }) || [];
  const today = jstDateStr();
  const future = holidays.filter(d => d >= today).sort();
  if (!future.length) return replyToLine(replyToken,
    '休日が登録されていません。\n\n例：休日登録 5/19 5/23 5/27',
    { items: [btn('休日登録')] }, env);
  const days = ['日','月','火','水','木','金','土'];
  const lines = future.map((d, i) => {
    const dt = new Date(d+'T00:00:00');
    const label = i === 0 ? '次の休み' : i === 1 ? '次の次の休み' : `${i+1}番目の休み`;
    return `・${dt.getMonth()+1}/${dt.getDate()}（${days[dt.getDay()]}）← ${label}`;
  });
  await replyToLine(replyToken, `🗓 休日一覧\n\n${lines.join('\n')}`,
    { items: [btn('休日登録'), btn('休日削除')] }, env);
}

async function handleHolidayDelete(replyToken, text, env) {
  const target = text.replace('休日削除 ', '').trim();
  const today = jstDateStr();
  const d = parseHolidayDate(target, today);
  if (!d) return replyToLine(replyToken, `日付の形式が正しくありません。\n例：休日削除 5/19`, QR_DEFAULT, env);
  const list = await env.TASKS.get('holidays', { type: 'json' }) || [];
  const newList = list.filter(x => x !== d);
  if (newList.length === list.length) return replyToLine(replyToken, `${target} は登録されていません。`, { items: [btn('休日一覧')] }, env);
  await env.TASKS.put('holidays', JSON.stringify(newList));
  await replyToLine(replyToken, `🗑 ${target} を削除しました。`, { items: [btn('休日一覧')] }, env);
}

function parseHolidayDate(str, today) {
  const m = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const month = String(parseInt(m[1])).padStart(2, '0');
  const day = String(parseInt(m[2])).padStart(2, '0');
  const year = today.slice(0, 4);
  const candidate = `${year}-${month}-${day}`;
  // 過去の日付なら来年に
  return candidate >= today ? candidate : `${parseInt(year)+1}-${month}-${day}`;
}


const DAY_MAP = { '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6, '日': 0 };

function parseInterval(s) {
  const m = s.match(/^(?:毎(\d+)日|(\d+)日(?:ごと|に1回))$/);
  return m ? parseInt(m[1] || m[2]) : null;
}

function isValidSchedule(s) {
  if (s === '毎日') return true;
  if (s.startsWith('毎週')) { const d = s.replace('毎週', '').replace(/曜日?/, ''); return d in DAY_MAP; }
  if (s.startsWith('毎月')) { const n = parseInt(s.replace('毎月', '').replace('日', '')); return n >= 1 && n <= 31; }
  return parseInterval(s) !== null;
}

function matchesSchedule(schedule, now, lastAdded) {
  if (schedule === '毎日') return true;
  if (schedule.startsWith('毎週')) {
    const d = schedule.replace('毎週', '').replace(/曜日?/, '');
    return now.getDay() === DAY_MAP[d];
  }
  if (schedule.startsWith('毎月')) {
    const n = parseInt(schedule.replace('毎月', '').replace('日', ''));
    return now.getDate() === n;
  }
  const interval = parseInterval(schedule);
  if (interval !== null) {
    if (!lastAdded) return true;
    const last = new Date(lastAdded + 'T00:00:00+09:00');
    return Math.floor((now - last) / 86400000) >= interval;
  }
  return false;
}

function jstDateStr(date) {
  const d = date || new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** n 日前の JST 日付文字列 */
function jstDateStrDaysAgo(n) {
  return jstDateStr(new Date(Date.now() + 9 * 60 * 60 * 1000 - n * 86400000));
}

// ─── 汚れの記録 ──────────────────────────────────────────────────
// 「汚れる原因」に気づいた瞬間を記録するだけの機能。タスクには一切干渉しない。
// 目的は「どの場面が実際に多いか」を実データで知ること。多いものが分かったら
// 道具の配置を変えるなどの環境側の対策を打ち、習慣化したら記録をやめてよい。
// 半角/全角の ! と、! の後ろのスペース有無をどちらも許容する。
const DIRT_PREFIX_RE = /^記録\s*[!！]\s*/;
const DIRT_LOG_MAX = 1000;   // KV の値サイズを抑えるため古いものから捨てる
const DIRT_WINDOW = 14;      // 集計の対象期間(日)

/** 期間内の {ラベル: 回数} を多い順に */
function dirtCounts(log, days) {
  const since = jstDateStrDaysAgo(days);
  const counts = {};
  log.filter(e => e.at >= since).forEach(e => { counts[e.text] = (counts[e.text] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

/** よく記録しているものをクイックリプライに出す(2回目以降はタップだけで記録できる) */
function dirtQuickReply(log) {
  // LINE のラベルは 20 文字までなので切る。送信テキストは全文のまま
  const top = dirtCounts(log, 30).slice(0, 4)
    .map(([t]) => btn(t.length > 20 ? t.slice(0, 19) + '…' : t, `記録！${t}`));
  return { items: [...top, btn('記録一覧')] };
}

/** 保存前の正規化。決定的に潰せるゆれだけを対象にする
    (全角/半角、連続スペース、末尾の句読点・記号)。
    ひらがな/漢字/カタカナや言い回しの違いは、集計時に AI でまとめる */
function normalizeDirtLabel(s) {
  return s.normalize('NFKC')          // ｺﾞﾐ → ゴミ、１ → 1 など
    .replace(/\s+/g, ' ')             // 連続スペースを1つに
    .replace(/^[\s。、,.]+|[\s。、,.!！?？~〜ー]+$/g, '')  // 前後の空白・句読点・記号
    .trim();
}

async function handleDirtLog(replyToken, rawText, env) {
  const label = normalizeDirtLabel(rawText.replace(DIRT_PREFIX_RE, ''));
  const log = await env.TASKS.get('dirt_log', { type: 'json' }) || [];

  if (!label) {
    return replyToLine(replyToken,
      '記録の形式：\n記録！ ふきこぼれ\n\n汚れに気づいたら送ってください。タスクにはならず、記録だけ残ります。\n\n例）\n記録！ ものをこぼした\n記録！ ゴミ袋がいっぱい\n記録！ 服を脱いだ',
      dirtQuickReply(log), env);
  }

  log.push({ text: label, at: jstDateStr() });
  const trimmed = log.slice(-DIRT_LOG_MAX);
  await env.TASKS.put('dirt_log', JSON.stringify(trimmed));

  console.log('[記録]', label, `(2週間で${trimmed.filter(e => e.text === label && e.at >= jstDateStrDaysAgo(DIRT_WINDOW)).length}回目)`);
  const n = trimmed.filter(e => e.text === label && e.at >= jstDateStrDaysAgo(DIRT_WINDOW)).length;
  await replyToLine(replyToken, `✓ 記録：${label}（2週間で${n}回目）`, dirtQuickReply(trimmed), env);
}

/** 表記ゆれを AI でまとめる。[[代表名, 合計回数, [元の表記...]], ...] を返す。
    失敗時は null を返し、呼び出し側は素の集計にフォールバックする。
    生ログは書き換えないので、まとめ方が気に入らなくても記録自体は失われない */
async function groupDirtLabels(ranked, env) {
  const labels = ranked.map(([t]) => t);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: `role:表記ゆれの統合|out:JSONのみ・前置き不要
同一の事象を指すものだけをまとめる。ひらがな/漢字/カタカナ違い、送り仮名・助詞の有無、語尾違いは同一とみなす
例:"ふきこぼれ"="吹きこぼれ"="フキコボレ"|"服を脱いだ"="服脱いだ"|"ゴミ袋がいっぱい"="ごみ袋いっぱい"
NG:場所や対象が違うものは絶対にまとめない("床を拭く"と"机を拭く"は別)
name:そのグループで最初に出てくる表記をそのまま使う
入力の全要素をどれかのグループに必ず入れる(取りこぼし禁止)
fmt:{"groups":[{"name":"","members":[""]}]}`,
        messages: [{ role: 'user', content: JSON.stringify(labels) }]
      })
    });
    if (!res.ok) {
      console.error('[ERROR] 表記ゆれ統合のAPI失敗', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    const groups = JSON.parse(data.content[0].text.replace(/```json|```/g, '').trim()).groups || [];
    const countOf = Object.fromEntries(ranked);
    const used = new Set();
    const out = [];
    for (const g of groups) {
      const members = (g.members || []).filter(m => countOf[m] !== undefined && !used.has(m));
      if (!members.length) continue;
      members.forEach(m => used.add(m));
      out.push([g.name || members[0], members.reduce((s, m) => s + countOf[m], 0), members]);
    }
    // AI が取りこぼした分は素のまま足す(件数が合わなくなるのを防ぐ)
    for (const [t, c] of ranked) if (!used.has(t)) out.push([t, c, [t]]);
    return out.sort((a, b) => b[1] - a[1]);
  } catch (e) {
    console.error('[ERROR] 表記ゆれ統合に失敗:', e && (e.message || e));
    return null;
  }
}

async function handleDirtList(replyToken, env) {
  const log = await env.TASKS.get('dirt_log', { type: 'json' }) || [];
  if (!log.length) {
    return replyToLine(replyToken,
      '記録はまだありません。\n\n汚れに気づいたら「記録！ ふきこぼれ」のように送ってください。2週間ためると、実際に多い場面が分かります。',
      { items: [btn('ヘルプ')] }, env);
  }
  const ranked = dirtCounts(log, DIRT_WINDOW);
  if (!ranked.length) {
    return replyToLine(replyToken,
      `直近2週間の記録はありません。\n（全期間の記録は ${log.length}件）`,
      dirtQuickReply(log), env);
  }
  const total = ranked.reduce((s, [, c]) => s + c, 0);
  // 「ふきこぼれ/吹きこぼれ」のような表記ゆれを AI でまとめる。
  // 失敗しても集計自体は出せるよう、そのままの一覧にフォールバックする
  const grouped = ranked.length > 1 ? await groupDirtLabels(ranked, env) : null;
  const lines = (grouped || ranked).map(([t, c, variants]) =>
    `・${t}　${c}回` + (variants && variants.length > 1 ? `\n　（${variants.join(' / ')}）` : ''));
  const msg = `🧹 直近2週間の記録（${total}件）\n\n${lines.join('\n')}\n\n多いものから、道具の置き場所を変えてみてください。`;
  await replyToLine(replyToken, msg, dirtQuickReply(log), env);
}

// ─── ヘルプ ──────────────────────────────────────────────────────
const HELP_QR = { items: [
  btn('ヘルプ：タスク'),
  btn('ヘルプ：定期'),
  btn('ヘルプ：休日'),
  btn('ヘルプ：コマンド'),
]};

const HELP_OVERVIEW = `📖 FocusFlow ヘルプ

詳しく知りたいカテゴリをタップしてください👇

📝 タスク追加のコツ
🔁 定期タスク
🗓 休日・実行日の設定
📋 コマンド一覧

🧹 汚れの記録
「記録！ ふきこぼれ」と送るとタスクにならず記録だけ残ります。「記録一覧」で多い順に集計。`;

const HELP_TASK = `📝 タスク追加のコツ

テキストや写真をそのまま送るとタスクに変換されます。

【写真だけ送る】
画像を解析してタスクを自動生成します

【写真に指示を付けたいとき】
先に「写真: 〇〇」と送ってから60秒以内に写真を送る
例）「写真: 優先してやりたいことを3つ出して」→ 写真

【期限を設定したいとき】
「〜日まで」と書くと期限付きで登録されます
例）「5/31までにレポートを書く」

【実行日を設定したいとき】
「〜日にやる」と書くと後日実行予定に登録
例）「5/23に部屋を掃除する」

【休日に合わせてやりたいとき】
「次の休みに〇〇する」
「次の次の休みに〇〇する」`;

const HELP_RECURRING = `🔁 定期タスクの使い方

【登録】
定期登録 スケジュール タスク名

スケジュールの形式：
・毎日
・毎週月曜（火・水・木・金・土・日も可）
・毎月1日（日付で指定）
・3日ごと（3日に1回・毎3日も可）

例）
定期登録 毎日 薬を飲む
定期登録 毎週月曜 燃えるゴミを出す
定期登録 毎月1日 家賃を確認する
定期登録 3日ごと 掃除機をかける

【確認・削除】
定期一覧 → 登録中のタスクを表示
定期削除 タスク名 → 削除`;

const HELP_HOLIDAY = `🗓 休日・実行日の使い方

【休日の登録】
休日登録 5/19 5/23 5/27
→ スペース区切りでまとめて登録できます

【休日の確認・削除】
休日一覧 → 「次の休み」「次の次の休み」で表示
休日削除 5/19 → 特定の日を削除

【タスクに使う】
「次の休みに部屋の掃除をする」
→ 次の休日が自動で実行日に設定されます

「次の次の休みに病院に行く」
→ 2番目の休日が実行日に設定されます`;

const HELP_COMMANDS = `📋 コマンド一覧

【確認】
一覧 → 現在のタスク一覧
定期一覧 → 定期タスク一覧
休日一覧 → 登録済み休日一覧
記録一覧 → 汚れの記録を多い順に

【汚れの記録】
記録！ ふきこぼれ
→ タスクにならず記録だけ残る

【定期タスク】
定期登録 スケジュール 名前
定期削除 名前

【休日】
休日登録 5/19 5/23 ...
休日削除 5/19

【ヘルプ】
ヘルプ → このメニュー
ヘルプ：タスク / 定期 / 休日 / コマンド`;

// ─── LINE送信 ────────────────────────────────────────────────────
async function replyToLine(replyToken, text, quickReply, env) {
  const message = { type: 'text', text };
  if (quickReply) message.quickReply = quickReply;
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN.replace(/\s/g, '')}` },
    body: JSON.stringify({ replyToken, messages: [message] })
  });
  // 失敗しても例外は出ない(fetch は 4xx でも resolve する)ので明示的に見る。
  // 401/403 は LINE_CHANNEL_ACCESS_TOKEN が不正、400 は replyToken 期限切れなど
  if (!res.ok) console.error('[ERROR] LINE返信失敗', res.status, (await res.text()).slice(0, 300));
}

async function pushToLine(userId, text, env) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN.replace(/\s/g, '')}` },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] })
  });
}

// ─── 署名検証 ────────────────────────────────────────────────────
async function verifySignature(body, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig))) === signature;
}
