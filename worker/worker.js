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
  if (text?.startsWith('記録一覧')) return handleDirtList(replyToken, text.slice(4), env);
  if (text?.startsWith('記録詳細')) return handleDirtDetail(replyToken, text.slice(4), env);
  if (text && DIRT_PREFIX_RE.test(text)) return handleDirtLog(replyToken, text, env);

  // 「写真:」プレフィックス → 先に指示を預かる(この時点ではタスクにしない)
  if (event.message.type === 'text' && text?.startsWith('写真:') && event.source?.userId) {
    const instruction = text.replace(/^写真[:：]\s*/, '').trim();
    await env.TASKS.put(
      `text_ctx_${event.source.userId}`,
      JSON.stringify({ text: instruction, timestamp: Date.now() }),
      { expirationTtl: PHOTO_CTX_TTL }
    );
    return replyToLine(replyToken,
      `📷 指示を受け取りました：「${instruction}」\n${PHOTO_CTX_TTL / 60}分以内に写真を送ってください。`,
      { items: [btn('ヘルプ')] }, env);
  }

  // 「補足:」→ 直前に送った写真を、補足を加えて解析し直す。
  // 写真を送ってから内容を見て直せるので、事前に指示を考えておく必要がない
  if (event.message.type === 'text' && DIRT_SUPPLEMENT_RE.test(text || '') && event.source?.userId) {
    const supplement = text.replace(DIRT_SUPPLEMENT_RE, '').trim();
    const ctx = await env.TASKS.get(`photo_ctx_${event.source.userId}`, { type: 'json' });
    if (!ctx) {
      return replyToLine(replyToken,
        `補足できる写真がありません。\n写真を送ってから${PHOTO_CTX_TTL / 60}分以内に「補足: 〜」と送ってください。`,
        QR_DEFAULT, env);
    }
    if (!supplement) {
      return replyToLine(replyToken, '補足の内容を書いてください。\n例）補足: 床だけでいい', QR_DEFAULT, env);
    }
    return analyzeImage(replyToken, ctx.messageId,
      `${supplement}\n\nこの指示を最優先で、この画像を見てタスクに分解してください。`,
      env, event.source.userId, ctx.batchId);
  }

  // 画像 → 「写真:」で事前に預けた指示があればそれを使う
  if (event.message.type === 'image') {
    let instruction = DEFAULT_IMAGE_INSTRUCTION;
    if (event.source?.userId) {
      const cached = await env.TASKS.get(`text_ctx_${event.source.userId}`, { type: 'json' });
      if (cached && Date.now() - cached.timestamp < PHOTO_CTX_TTL * 1000) {
        instruction = `${cached.text}\n\nこの指示を最優先で、この画像を見てタスクに分解してください。`;
        await env.TASKS.delete(`text_ctx_${event.source.userId}`);
      }
    }
    return analyzeImage(replyToken, event.message.id, instruction, env, event.source?.userId, null);
  }

  // 通常タスク追加（Claude API）
  const newTasks = await askClaudeForTasks([{ type: 'text', text }], env);
  if (!newTasks) {
    await replyToLine(replyToken, '処理できませんでした。もう一度送ってみてください。', QR_DEFAULT, env);
    return;
  }
  await addTasksAndReply(replyToken, newTasks, env, null, null);
}

// ─── Claude にタスク分解を依頼する ───────────────────────────────
// 文章と画像でモデルを分けてある。
// 画像の誤認識(写っていない物を挙げる)が減らない場合は MODEL_IMAGE だけ上げる:
//   Haiku 4.5 … 画像を長辺1568pxまでに縮小。$1/$5 per MTok。写真1枚 約1.4円
//   Sonnet 5  … 長辺2576pxまで扱える(画素数で約2.7倍)。$3/$15。写真1枚 約5.5円
// ※ temperature は Sonnet 5 / Opus 5 では非デフォルト値が400エラーになるので使えない
const MODEL_TEXT  = 'claude-haiku-4-5';
const MODEL_IMAGE = 'claude-haiku-4-5';   // → 'claude-sonnet-5' に変えるだけで画像だけ上がる

/**
 * userContent は Claude の content 配列そのまま（テキストのみ / 画像+テキスト）。
 * 成功したらタスク配列、API エラーや JSON 破損なら null を返す。
 */
async function askClaudeForTasks(userContent, env) {
  const hasImage = userContent.some(c => c.type === 'image');
  const model = hasImage ? MODEL_IMAGE : MODEL_TEXT;
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
      model,
      max_tokens: 4000,
      system: `role:タスク管理AI|out:JSONのみ・前置き不要|date:${today}${holidayPrompt}
title:ユーザーが書いた言葉をそのまま使う。別のタスクに置き換えない(画像のみの場合は場所の名前で自分で付ける)
task_n(文章の場合):原則1件。「AとBとCのX」のAとBとCはXの修飾であってタスクの列挙ではない→"X"1件にする。述語(最後の動詞)が何を求めているかで判断。動詞が複数あり明確に別件の時だけ複数件
画像がある場合:
 ■タスクは必ず1件。titleは「何をするか」で付ける
  作業が1種類なら、その作業名にする ex:シンクに汚れた食器 → "食器を洗う"
  種類が混ざっていて場所でまとめる方が自然な時だけ場所名 ex:部屋全体 → "リビングの片付け"
  ✗"ソファの片付け","床の片付け","テーブルの片付け"と分ける ✓"リビングの片付け"1件。ソファ/床/テーブルはstep
  道具も置き場所も違う作業(ex:洗い物と洗濯)が同時に写っている時だけ2件まで。それ以外は必ず1件
  placeにはtitleと別に、写っている場所名を必ず入れる(ex:"キッチン")
 ■片付け(物を動かす)だけが対象ではない。洗う/拭く/捨てる も必要なら挙げる
  汚れた食器は「戻す」のではなく「洗う」。濡れ・こぼれは「拭く」
 ■stepは「物の種類」ごとに1つ。同じ種類の物が何個あってもstepは1つ。散らかっていてもstepは増えない
  ✗"花柄の服を洗濯かごに入れる","ピンクの服を洗濯かごに入れる" ✓"床に落ちている服を洗濯かごに入れる"
  色/柄/素材/ブランド/サイズでstepを分けない。これらの語をstepに書かない
  ✗"雑誌Aを戻す","雑誌Bを戻す" ✓"床の雑誌を棚に戻す"
  何がどこにあるかは具体的に(✗"床を片付ける" ✓"床の雑誌を棚に戻す")
 ■stepは必ず(何を)+(どうする)。対象の無いstepは禁止
  ✗"片付ける" ✗"きれいにする" ✗"掃除する" ✗"整理する" ←何をするか分からない
  ✓"シンクの食器を洗う" ✓"排水溝のゴミを捨てる"
  写っている物が1種類しかなくても、必ずその物の名前を書く
 ■推測で足さない。ただし判断の単位は「種類」であって個体ではない
  山になっていて1枚1枚は見えなくても、食器の山と分かれば"シンクの食器"と書いてよい。
  重なっている・一部しか見えない は、書かない理由にならない
  飛ばすのは種類そのものが分からない物だけ
  禁止なのは写っていない物を足すこと ✗写真に無い「冷蔵庫の中身」「引き出しの中」
  ✗一般的な部屋にありそう、という理由での追加
  置き場所(着点)が写っていない時は"元の場所に戻す"でよい。存在しない収納を作らない
 ■step同士を重ねない。同じ物が2つのstepに出てきてはいけない
  広いstepと細かいstepを混ぜない ✗"床を片付ける"と"床の雑誌を棚に戻す"が両方 ✓細かい方だけ
 ■文章が併記されていればそれを最優先の指示として扱う(範囲の限定・優先順位・やらないことの指定など)
 ex:シンクに汚れた食器の山 → title"食器を洗う" place"キッチン"
  step:"シンクの食器を洗う","洗った食器を水切りかごに置く","排水溝のゴミを捨てる"
 ■出力する前に確認:タスクは1件か?|対象の無いstep("片付ける"等)が無いか?|色/柄/素材の語が入っていないか?|同じ種類が2stepに分かれていないか?
思考タスク:"考える/決める/計画/設計/検討/見直す"はその思考作業自体が1タスク。中身を実行タスクに展開するのは禁止(まだやると決まっていないため)。stepは思考の進め方にする
 ex:"AとBとCのスケジュールを考える"→✗"Aを実施","Bを追加","Cを暗記"の3タスク化
  ✓"スケジュールを考える"1件|step:"紙とペンを出す","A/B/Cそれぞれの所要時間を書き出す","今週の空き時間を確認する","カレンダーに書き込む"
step:1step=「完了の瞬間の写真が撮れる」単一動作(=終了後にモノがどこにあるか一意に決まる)|着点必須(何を+どこへ)|5分以内|目安3〜8
分ける基準:場所が変わる時と、扱う物・道具が変わる時だけ分ける。同じ場所で続けてできる動作は1stepにまとめる
 ✗"掃除機を手に取る"✗"蓋を開ける"←その場に着けば自然に続くので不要|○"掃除機のところまで行く"←移動は分ける
粒度:同じ種類・同じ場所のものは1step。個体を色/柄/ブランドで区別しない
 ✗"花柄の服を洗濯かごに入れる","ピンクの服を洗濯かごに入れる" ✓"床に落ちている服を洗濯かごに入れる"
禁止語:用意/準備/セット/対応/処理/整理/まとめる/済ませる ←状態語であって動作ではない
着点を補え:しまう/戻す/片付ける→"〜に入れる","〜に置く"(どこへ を必ず書く)
OK動詞:〜まで行く/〜に置く/〜に入れる/かける/運ぶ/拭く/洗う/捨てる/アプリを開く/入力する/送信ボタンを押す
必ず入れる(物理作業のみ。思考タスクには不要):移動"〜まで行く"|本作業|後始末"〜に入れる/置く/捨てる"
ex:床を清掃する→"掃除機のところまで行く","床に掃除機をかける","掃除機を元の場所に置く","雑巾の棚まで行く","床を拭く","雑巾を洗濯かごに入れる"
ex:メールを送る→"アプリを開く","本文を入力する","送信ボタンを押す"
check:移動"〜まで行く"と後始末"戻す/捨てる"が抜けてないか?|同じ場所での細かい動作を分けすぎてないか?
urgency:must=今日中|want=近いうち|nice=できれば|scheduled=特定日指定(scheduledDate必須)
trigger:「〜日にやる」「次の休みに」→scheduled|「〜日まで」→dueDate
RULE:scheduledDateが今日より未来の場合はurgencyを必ずscheduledにする・mustやwantにしてはいけない
field:dueDate=締切|scheduledDate=実行予定日|place=画像の時だけ場所名(ex:"リビング")|該当なければ省略
fmt:{"tasks":[{"id":"task_1","title":"","place":"","urgency":"must","dueDate":"YYYY-MM-DD","scheduledDate":"YYYY-MM-DD","steps":[{"id":"step_1","title":"","estimatedMinutes":5,"done":false}]}]}`,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!claudeRes.ok) {
    console.error('[ERROR] Claude API', claudeRes.status, (await claudeRes.text()).slice(0, 300));
    return null;
  }
  try {
    const claudeData = await claudeRes.json();
    const jsonText = claudeData.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(jsonText).tasks || [];
  } catch (e) {
    console.error('[ERROR] Claude の応答を解釈できない:', e && (e.message || e));
    return null;
  }
}

// ─── 画像の解析 ──────────────────────────────────────────────────
const PHOTO_CTX_TTL = 300;                       // 写真の指示/補足を受け付ける秒数
const DIRT_SUPPLEMENT_RE = /^補足\s*[:：]\s*/;
const DEFAULT_IMAGE_INSTRUCTION =
  '写っている範囲を見て、片付け・掃除が必要な箇所を挙げてください。' +
  'タスクは必ず1件にまとめ、個々の箇所はその中のステップにしてください。' +
  'ステップは物の種類ごとに1つにし、色や柄で分けないでください。';

// Claude API の 1 画像あたりの上限は base64 で 5MB。元データだと 5MB×3/4。
const IMAGE_BYTES_MAX = 5 * 1024 * 1024 * 3 / 4;

/**
 * LINE から画像を取得して {base64, mediaType} を返す。
 * media_type は決め打ちにせず Content-Type を使う (LINE は PNG を返すこともある)。
 */
async function fetchLineImage(messageId, env) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN.replace(/\s/g, '')}` } });
  if (!res.ok) {
    console.error('[ERROR] LINE画像の取得に失敗', res.status);
    return null;
  }
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const mediaType = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(ct) ? ct : 'image/jpeg';

  const uint8 = new Uint8Array(await res.arrayBuffer());
  console.log('[画像取得]', mediaType, `${Math.round(uint8.length / 1024)}KB`);
  if (uint8.length > IMAGE_BYTES_MAX) {
    console.error('[ERROR] 画像が大きすぎる', uint8.length, '> 上限', Math.round(IMAGE_BYTES_MAX));
    return null;
  }
  // 1文字ずつ足すと巨大な文字列になるのでチャンクに分ける
  let binary = '';
  for (let i = 0; i < uint8.length; i += 8192) {
    binary += String.fromCharCode.apply(null, uint8.subarray(i, i + 8192));
  }
  return { base64: btoa(binary), mediaType };
}

const URGENCY_RANK = { must: 0, want: 1, nice: 2, scheduled: 3 };
// 「〜の片付け」のような、何をするのか分からないタイトル
const GENERIC_TITLE_RE = /片付|掃除|整理|きれい|キレイ|綺麗/;
// 対象が書かれていない step。これしか出ていない時は解析が失敗している
const VAGUE_STEP_RE = /^(片付ける|片づける|かたづける|掃除する|そうじする|整理する|きれいにする|キレイにする|綺麗にする)$/;
const stepText = s => (typeof s === 'string' ? s : (s && (s.text || s.title)) || '').trim();

/**
 * 画像から複数タスクが返ってきたら1件にまとめる。
 * プロンプトで「1件」と指示しても毎回は守られない(同じ写真でも回によって分割される)ため、
 * モデル任せにせずここで確定させる。step は種類ごとに1つなので単純に連結して重複を落とす。
 */
function mergeImageTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length <= 1) return tasks;

  const place = tasks.map(t => (t.place || '').trim()).find(Boolean);
  // 「食器を洗う」のような具体的な作業名があれば、場所名より優先して残す。
  // 場所名に書き換えると、何をするタスクなのかが消えてしまう
  const specific = tasks
    .filter(t => (t.title || '').trim() && !GENERIC_TITLE_RE.test(t.title))
    .sort((a, b) => (b.steps || []).length - (a.steps || []).length)[0];
  const title = specific ? specific.title.trim()
    : place ? `${place}の片付け`
    : (tasks[0].title || '片付け');

  const steps = [];
  const seen = new Set();
  for (const t of tasks) {
    for (const s of t.steps || []) {
      const label = (typeof s === 'string' ? s : (s.text || s.title || '')).trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      steps.push(s);
    }
  }
  const urgency = tasks.map(t => t.urgency || 'want')
    .sort((a, b) => (URGENCY_RANK[a] ?? 9) - (URGENCY_RANK[b] ?? 9))[0];

  console.log('[統合]', tasks.length, '件のタスクを1件に:', JSON.stringify(title),
    `step ${tasks.reduce((n, t) => n + (t.steps || []).length, 0)}→${steps.length}`);
  return [{ id: 'task_1', title, urgency, steps }];
}

/** 画像を解析してタスクを追加。replaceBatchId があれば、その回の結果を差し替える */
async function analyzeImage(replyToken, messageId, instruction, env, userId, replaceBatchId) {
  const img = await fetchLineImage(messageId, env);
  if (!img) {
    return replyToLine(replyToken, '画像を取得できませんでした。もう一度送ってみてください。', QR_DEFAULT, env);
  }
  console.log('[画像解析]', replaceBatchId ? '補足で再解析' : '新規', JSON.stringify(instruction.slice(0, 60)));
  const newTasks = await askClaudeForTasks([
    { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
    { type: 'text', text: instruction }
  ], env);
  if (!newTasks) {
    return replyToLine(replyToken, '処理できませんでした。もう一度送ってみてください。', QR_DEFAULT, env);
  }
  const merged = mergeImageTasks(newTasks);
  merged.forEach(t => { delete t.place; });   // place は統合用。アプリには渡さない

  // 補足で解析し直せるよう、この写真と今回追加したタスクを紐づけて覚えておく
  const batchId = 'img' + Date.now();
  if (userId) {
    await env.TASKS.put(`photo_ctx_${userId}`,
      JSON.stringify({ messageId, batchId, timestamp: Date.now() }), { expirationTtl: PHOTO_CTX_TTL });
  }
  await addTasksAndReply(replyToken, merged, env, batchId, replaceBatchId);
}

/** pending に追加して結果を返信する。replaceBatchId 指定時は前回分を取り除く */
async function addTasksAndReply(replyToken, newTasks, env, batchId, replaceBatchId) {
  if (batchId) newTasks.forEach((t, i) => { t.id = `${batchId}_${i}`; });
  let existing = await env.TASKS.get('pending', { type: 'json' }) || [];
  let note = '';
  if (replaceBatchId) {
    const before = existing.length;
    existing = existing.filter(t => !String(t.id || '').startsWith(replaceBatchId));
    // アプリが既に取り込んでいると pending には残っていない。その場合は差し替えられない
    note = before === existing.length
      ? '\n\n⚠️ 前回分は既にアプリに取り込まれていたため、置き換えずに追加しました。アプリ側で不要なものを削除してください。'
      : '\n\n（前回の解析結果は置き換えました）';
  }
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
  if (!replyMsg) replyMsg = 'タスクは見つかりませんでした。';
  // 「片付ける」だけのような、対象の無い step しか出ていない時は解析が失敗している。
  // 黙って使えないタスクを登録せず、やり直せることを伝える
  if (batchId) {
    const steps = newTasks.flatMap(t => t.steps || []).map(stepText).filter(Boolean);
    if (!steps.length || steps.every(x => VAGUE_STEP_RE.test(x))) {
      console.log('[警告] 中身の無い解析結果:', JSON.stringify(steps));
      note += '\n\n⚠️ 写真から具体的な内容を読み取れませんでした。' +
        '明るい場所で近づいて撮り直すか、「補足: シンクの食器を洗いたい」のように文章で補ってください。';
    }
  }
  if (batchId && !replaceBatchId) {
    replyMsg += '\n\n💡 直したいときは「補足: 床だけでいい」のように送ると解析し直します。';
  }

  await replyToLine(replyToken, replyMsg + note, QR_TASK, env);
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
const DIRT_WINDOW = 14;      // 「○回目」の即時フィードバックに使う期間(日)

/** 「記録一覧 1ヶ月」などの期間指定を日数に。null は全期間 */
function parseDirtRange(arg) {
  const s = (arg || '').normalize('NFKC').replace(/\s/g, '');
  if (!s || /^(全部|全期間|すべて|全て|ぜんぶ)$/.test(s)) return { days: null, label: '全期間' };
  const m = s.match(/^(\d+)\s*(日|週間?|[ヶかカヵ]?月)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  if (m[2].startsWith('日')) return { days: n, label: `直近${n}日` };
  if (m[2].startsWith('週')) return { days: n * 7, label: `直近${n}週間` };
  return { days: n * 30, label: `直近${n}ヶ月` };
}

/** 期間内の {ラベル: 回数} を多い順に。days が null なら全期間 */
function dirtCounts(log, days) {
  const since = days == null ? '' : jstDateStrDaysAgo(days);
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

  const same = trimmed.filter(e => e.text === label);
  const n = same.filter(e => e.at >= jstDateStrDaysAgo(DIRT_WINDOW)).length;
  // 通算も出す。2週間だと少なく見えて「溜まっていない」と誤解しやすいため
  const suffix = same.length > n ? `（2週間で${n}回目 / 通算${same.length}回）` : `（2週間で${n}回目）`;
  console.log('[記録]', label, suffix);
  await replyToLine(replyToken, `✓ 記録：${label}${suffix}`, dirtQuickReply(trimmed), env);
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

async function handleDirtList(replyToken, arg, env) {
  const log = await env.TASKS.get('dirt_log', { type: 'json' }) || [];
  if (!log.length) {
    return replyToLine(replyToken,
      '記録はまだありません。\n\n汚れに気づいたら「記録！ ふきこぼれ」のように送ってください。ためると、実際に多い場面が分かります。',
      { items: [btn('ヘルプ')] }, env);
  }
  const range = parseDirtRange(arg);
  if (!range) {
    return replyToLine(replyToken,
      '期間の指定が読み取れませんでした。\n\n記録一覧 → 全期間\n記録一覧 2週間\n記録一覧 1ヶ月\n記録一覧 30日',
      dirtQuickReply(log), env);
  }
  const ranked = dirtCounts(log, range.days);
  if (!ranked.length) {
    return replyToLine(replyToken,
      `${range.label}の記録はありません。\n（全期間の記録は ${log.length}件）\n\n「記録一覧」だけ送ると全期間で出ます。`,
      dirtQuickReply(log), env);
  }
  const total = ranked.reduce((s, [, c]) => s + c, 0);
  // 対象になった記録の実際の日付幅。「30日分」と「実際に記録があった期間」は違う
  const dates = log.filter(e => range.days == null || e.at >= jstDateStrDaysAgo(range.days))
    .map(e => e.at).sort();
  const span = dates.length ? `${dates[0]} 〜 ${dates[dates.length - 1]}` : '';

  // 「ふきこぼれ/吹きこぼれ」のような表記ゆれを AI でまとめる。
  // 失敗しても集計自体は出せるよう、そのままの一覧にフォールバックする
  const grouped = ranked.length > 1 ? await groupDirtLabels(ranked, env) : null;
  const lines = (grouped || ranked).map(([t, c, variants]) =>
    `・${t}　${c}回` + (variants && variants.length > 1 ? `\n　（${variants.join(' / ')}）` : ''));
  const msg = `🧹 ${range.label}の記録（${total}件）\n${span}\n\n${lines.join('\n')}\n\n` +
    '多いものから、道具の置き場所を変えてみてください。\n' +
    '（期間を変える：記録一覧 2週間 / 1ヶ月）';
  await replyToLine(replyToken, msg, dirtQuickReply(log), env);
}

/** 日付ごとの記録。件数だけでは分からない「毎日なのか特定の日に固まるのか」を見るため */
async function handleDirtDetail(replyToken, arg, env) {
  const log = await env.TASKS.get('dirt_log', { type: 'json' }) || [];
  if (!log.length) {
    return replyToLine(replyToken, '記録はまだありません。', { items: [btn('ヘルプ')] }, env);
  }
  const range = parseDirtRange(arg);
  if (!range) {
    return replyToLine(replyToken, '期間の指定が読み取れませんでした。\n例）記録詳細 1ヶ月', dirtQuickReply(log), env);
  }
  const target = log.filter(e => range.days == null || e.at >= jstDateStrDaysAgo(range.days));
  if (!target.length) {
    return replyToLine(replyToken, `${range.label}の記録はありません。`, dirtQuickReply(log), env);
  }
  const byDate = {};
  target.forEach(e => { (byDate[e.at] = byDate[e.at] || []).push(e.text); });

  // 曜日は getDay() を使わない。Workers は UTC で動くので JST 深夜が前日と判定され、
  // 曜日が1日ずれる。日付文字列から直接 UTC で組み立てて getUTCDay() を使う
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const weekday = ds => {
    const [y, m, d] = ds.split('-').map(Number);
    return days[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  };
  // 新しい日から並べ、LINE の 5000 文字上限に収まる分だけ出す
  const head = `🧹 ${range.label}の記録（${target.length}件 / ${Object.keys(byDate).length}日）\n\n`;
  const all = Object.keys(byDate).sort().reverse().map(d => {
    return `${d.slice(5)}(${weekday(d)}) ${byDate[d].join('、')}`;
  });
  const lines = [];
  let len = head.length;
  for (const line of all) {
    if (len + line.length + 1 > 4700) break;
    lines.push(line); len += line.length + 1;
  }
  const omitted = all.length - lines.length;
  await replyToLine(replyToken,
    head + lines.join('\n') + (omitted ? `\n\n…ほか${omitted}日分は省略（期間を狭めてください）` : ''),
    dirtQuickReply(log), env);
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
「記録！ ふきこぼれ」と送るとタスクにならず記録だけ残ります。
「記録一覧」で多い順に集計（全期間）。「記録一覧 1ヶ月」で期間指定、「記録詳細」で日付ごと。`;

const HELP_TASK = `📝 タスク追加のコツ

テキストや写真をそのまま送るとタスクに変換されます。

【写真だけ送る】
画像を解析してタスクを自動生成します

【解析結果を直したいとき】← おすすめ
写真を送ったあと5分以内に「補足: 〇〇」と送ると、
その指示を最優先にして解析し直し、前回分を置き換えます
例）補足: 床だけでいい
　　補足: テーブルの上は触らない
　　補足: 洗い物を先にやりたい

【最初から指示を付けたいとき】
先に「写真: 〇〇」と送ってから5分以内に写真を送る
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
記録一覧 → 汚れの記録を多い順に（全期間）
記録一覧 1ヶ月 → 期間を絞る
記録詳細 → 日付ごとに一覧

【汚れの記録】
記録！ ふきこぼれ
→ タスクにならず記録だけ残る
記録一覧 → 多い順に集計（全期間）
記録一覧 2週間 / 1ヶ月 / 30日 → 期間指定
記録詳細 → 日付ごとに一覧（曜日や偏りを見る）

【写真】
写真: 〇〇 → このあと送る写真への指示
補足: 〇〇 → 直前の写真を指示付きで解析し直す

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
