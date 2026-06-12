# いっしょぐらし — 設計書

キャラクターと一緒に暮らしながら、日々のタスクをこなしてモチベーションを保つゲーム。
恋愛シミュレーション+育成ゲームの雰囲気。タスク達成でコインが貯まり、プレゼントやデートに使える。

## 技術方針

- バニラ JS / HTML / CSS のみ。ビルドツール・外部依存・外部通信なし。`file://` で開いても動くこと
- 永続化は `localStorage` キー `isshogurashi_v1`(JSON 一括保存)
- UI は日本語。ユーザー入力は必ずエスケープして表示(XSS 対策。`textContent` か専用 `esc()` を使う)
- スクリプト読み込み順: `js/character.js` → `js/gamedata.js` → `js/dialogue.js` → `js/app.js`
- 各ファイルは `window.*` のグローバル名前空間 1 つだけを公開する

## ファイル構成と担当

| ファイル | 内容 | 公開名 |
|---|---|---|
| `index.html` | 全画面の DOM 骨格 | — |
| `style.css` | 全スタイル | — |
| `js/character.js` | SVG 立ち絵レンダラー | `CharacterArt` |
| `js/gamedata.js` | 経済・レベル・プレゼント・デートの定義データ | `GameData` |
| `js/dialogue.js` | セリフエンジン+セリフデータ | `Dialogue` |
| `js/app.js` | 状態管理・画面遷移・タスク・UI ロジック全部 | `App`(任意) |

## 状態スキーマ(localStorage)

```js
{
  version: 1,
  player: { name: 'ぴな' },                  // プレイヤー名
  character: {
    name: 'ミナト',
    personality: 'tsundere',                 // 'tsundere'|'cool'|'caring'|'genki'|'sweet'
    firstPerson: 'わたし',                    // 一人称(自由入力)
    callName: 'ぴな',                         // ユーザーの呼び方(自由入力)
    suffix: '',                              // 任意の語尾(例:'にゃ')。空なら無効
    look: {
      hairStyle: 'long',                     // CharacterArt.HAIR_STYLES のいずれか
      hairColor: '#6b4f3a', eyeColor: '#4a6fa5',
      skinTone: '#ffe3cf', outfitColor: '#e8718d',
      accessory: 'none'                      // 'none'|'ribbon'|'glasses'|'flower'
    }
  },
  affection: 0,                              // 親密度(累積、減らない)
  coins: 0,
  streak: { current: 0, best: 0, lastAllDoneDate: null },  // 'YYYY-MM-DD'
  tasks: [{
    id, title,
    difficulty: 'easy'|'normal'|'hard',
    repeat: null | 'daily' | ['mon','tue',...],  // 繰り返し(null=単発)
    done: false, doneAt: null, createdAt
  }],
  memories: [{ date, type: 'gift'|'date'|'levelup', label }],  // 新しい順
  stats: { totalCompleted: 0, totalCoinsEarned: 0, totalGifts: 0, totalDates: 0 },
  lastVisit: 'YYYY-MM-DD'
}
```

## 性格プリセット(5 種)

| id | 名前 | 雰囲気 |
|---|---|---|
| `tsundere` | ツンデレ | 素直じゃないが根は優しい。親密度が上がるとデレ増量 |
| `cool` | クール | 落ち着いた敬語まじり。淡々と、でも的確に支えてくれる |
| `caring` | 世話焼き | おっとり優しいお姉さん/お兄さん気質。とにかく褒めて心配してくれる |
| `genki` | 元気 | 体育会系の応援団。テンション高くポジティブ |
| `sweet` | 甘えん坊 | 甘えた・かまってちゃん。一緒にいたがる。達成すると大喜び |

## モジュール契約

### CharacterArt(js/character.js)

```js
CharacterArt.HAIR_STYLES   // [{id:'short',name:'ショート'}, bob, long, twintail, ponytail]
CharacterArt.ACCESSORIES   // [{id:'none',name:'なし'}, ribbon, glasses, flower]
CharacterArt.EXPRESSIONS   // ['normal','smile','joy','blush','pout','sad','surprised','sleepy']
CharacterArt.render(look, expression)  // → SVG マークアップ文字列(viewBox 0 0 200 260)
```

立ち絵はデフォルメ調(2.5〜3 頭身)。表情は目・眉・口・頬の差分で表現。
呼び出し側は返り値を立ち絵コンテナの `innerHTML` に入れる(look の色値はカラーピッカー由来の `#hex` のみ)。

### GameData(js/gamedata.js)

```js
GameData.LEVELS        // [{lv:1,name:'知り合い',min:0}, {lv:2,'友達',60}, {3,'仲良し',150},
                       //  {4,'親友',300}, {5,'大切な人',500}, {6,'特別な関係',750}]
GameData.levelFor(affection)   // → LEVELS の該当エントリ
GameData.tierFor(affection)    // → 'low'(Lv1-2) | 'mid'(Lv3-4) | 'high'(Lv5-6)
GameData.ECONOMY = {
  coins:     { easy: 10, normal: 20, hard: 40 },
  affection: { easy: 2,  normal: 4,  hard: 8 },
  allDoneCoins: 30, allDoneAffection: 5,
  streakBonusPerDay: 5, streakBonusCap: 50,   // 全完了時 +min(streak*5, 50) コイン
}
GameData.GIFTS   // 10 種程度
// [{id, name, icon:'🌹', price, affection,
//    reactions: { tsundere: ['…',…], cool: […], caring: […], genki: […], sweet: […] }}]
// 価格帯 30〜500、affection は価格の 1/10 程度。reactions は各性格 2 つ以上
// (プレースホルダ {user}{me} 使用可。エンジンを通すので suffix 変換される)
GameData.DATE_SPOTS  // 5 箇所
// [{id, name, icon, price, minLevel, bgClass, affection,
//    script: [{ speaker:'char'|'narration',
//               lines: {tsundere:'…',cool:'…',caring:'…',genki:'…',sweet:'…'}  // narration は lines: '…'(共通文字列)
//            }, …(5〜7 ビート)]}]
// 例: カフェ(150, Lv1)、映画館(250, Lv2)、水族館(400, Lv3)、遊園地(600, Lv4)、温泉旅行(1000, Lv5)
// affection は 20〜80。script のキャラのセリフもプレースホルダ可
```

### Dialogue(js/dialogue.js)

```js
Dialogue.get(situation, state, extra = {})  // → セリフ文字列
Dialogue.format(text, state)                // プレースホルダ置換+語尾変換(GameData の reactions/script もこれで処理)
```

- 抽選: `DIALOGUE[personality][situation][tier]` の配列からランダム。`tier` は `GameData.tierFor(state.affection)`。直前と同じセリフは避ける(2 連続回避)
- プレースホルダ: `{user}` = character.callName、`{me}` = character.firstPerson、`{task}` = extra.task
- 語尾変換: `character.suffix` が非空なら、文末の `。!?♪…` の直前に挿入(全文一律。「だよ。」→「だよにゃ。」)
- セリフデータ: `DIALOGUE[personality][situation] = { low: [3〜5本], mid: […], high: […] }`

**situation 一覧**(5 性格 × 各 tier 3 本以上):

| situation | タイミング |
|---|---|
| `greeting_morning` | ホーム表示時 5〜10 時 |
| `greeting_day` | 10〜17 時 |
| `greeting_evening` | 17〜22 時 |
| `greeting_night` | 22〜5 時 |
| `task_add` | タスク追加時({task} 可) |
| `task_complete` | タスク完了時({task} 可) |
| `all_done` | その日の全タスク完了時 |
| `idle` | 立ち絵クリック時(雑談・好意。ここが一番「一緒に暮らしてる感」を出す。各 5 本以上) |
| `has_overdue` | 未完了タスクが残ったまま夕方以降 |
| `comeback` | 2 日以上ぶりの訪問(寂しがる・心配する) |
| `levelup` | 親密度レベルアップ時 |
| `setup_first` | 初回セットアップ完了直後の挨拶 |

tier による変化の方向: low=まだ距離がある → high=すっかり心を許している。
特にツンデレは low でツン強め・high でデレ多め、のように**関係の進展が読み取れる**書き分けをする。

## 画面構成(app.js + index.html)

SPA。`<section>` 切り替え方式。ナビは下部タブバー。

1. **セットアップウィザード**(初回のみ・3 ステップ)
   - Step1 見た目: 髪型・アクセ選択、髪/目/肌/服の色(`<input type="color">`)。プレビューは `CharacterArt.render` をリアルタイム反映
   - Step2 性格と話し方: 性格 5 択(説明+サンプルセリフ表示)、一人称・語尾(任意)入力
   - Step3 なまえ: キャラの名前、プレイヤー名、呼ばれたい名前 → 完了で `setup_first` のセリフと共にホームへ
2. **ホーム**: 部屋背景(時間帯 morning/day/evening/night で CSS グラデ変化)+立ち絵(クリックで `idle`)+吹き出し+ステータスバー(レベル・コイン・ストリーク)+今日のタスククイックリスト(チェックで完了)
3. **タスク**: 一覧・追加・編集・削除。難易度 3 択、繰り返し(なし/毎日/曜日指定)。完了時はコイン・親密度付与+ホームに戻ってリアクション表示
4. **プレゼント**: GIFTS のショップ。購入→キャラのリアクション(reactions から抽選、表情 joy/blush)+memories 記録
5. **おでかけ(デート)**: DATE_SPOTS 一覧(価格と必要レベル、未達はロック表示)。選ぶと全画面のビジュアルノベル風シーン: 背景(bgClass)+立ち絵+script をクリックで送る → 終了後 affection 付与+memories 記録
6. **きろく**: レベル(進捗バー)、ストリーク、累計統計、思い出タイムライン(memories)
7. **せってい**: キャラの見た目・性格・名前・話し方の再編集、データリセット(要確認)

## ゲームロジック要点(app.js)

- **完了処理**: コイン・親密度付与 → 吹き出しに `task_complete` → 全タスク完了なら続けて `all_done` +ボーナス+ストリーク更新(`lastAllDoneDate` が昨日なら current+1、それ以外は 1)
- **レベルアップ検知**: 親密度付与のたびに `levelFor` の変化を見て、変化したら `levelup` セリフ+お祝い演出+memories 記録
- **日付ロールオーバー**(起動時と `visibilitychange` で判定): `lastVisit` と今日が違えば、繰り返しタスクの `done` をリセット(曜日指定は該当曜日のみ表示対象)。単発タスクの完了済みは非表示化(アーカイブ)。2 日以上空いていたら挨拶を `comeback` に差し替え
- **表情の使い分け**: 通常 normal/smile、完了 joy、プレゼント joy/blush、has_overdue は pout/sad、夜 sleepy など状況に連動

## FocusFlow 連携(app.js)

同じユーザーの別アプリ **FocusFlow**(`piinatsu123-tech/focusflow1`)とタスクを連携する。
両アプリが同一オリジン(例: `https://piinatsu123-tech.github.io/` 配下)で公開されている前提で、
FocusFlow の localStorage キー **`ff-tasks`** を直接読み書きする。バックエンド不要。

- **タスク形式**: `{ id, text, done, urgency: 'must'|'want'|'nice'|'scheduled', steps, estimate }`
- **表示**: ホームのクイックリストとタスクタブに「⚡ FocusFlow」セクションとして未完了分を表示。
  `scheduled`(後日実行予定)は除外。編集・削除は FocusFlow 側で行う(こちらは完了のみ)
- **報酬マッピング**: `must`→hard / `want`→normal / `nice`→easy(ECONOMY 準拠)
- **こちらで完了**: `ff-tasks` に `done: true` を書き戻し(steps も done に)、FocusFlow 本体の
  `save()` と同様に Worker `/sync` へも best-effort で POST(LINE の「一覧」用)
- **FocusFlow 側で完了**: 起動時(800ms 遅延)・`visibilitychange`・`storage` イベントで検知し、
  まとめて報酬付与+キャラのリアクション。付与済み ID は `state.ff.rewardedIds` で管理し、
  FocusFlow 側で削除されたタスクの ID は掃除する
- **初回連携時**: その時点で完了済みのタスクは報酬対象にしない(`state.ff.initialized`)
- **全完了判定**: ネイティブ+FocusFlow(非 scheduled)の合算。`handleAllDone` は
  `lastAllDoneDate === today` なら何もしない(同日二重付与防止)
- **せってい**: 連携オン/オフのトグルと接続状態の表示。`ff-tasks` キーが無い環境では
  自動的に無効(状態スキーマに `ff: { enabled, initialized, rewardedIds }` を追加)

## ビジュアルトーン

- 暖かみのあるパステル系。角丸大きめ、影は柔らかく。フォントは system-ui 系で可
- 部屋背景は CSS のみで描く(窓+グラデの空、家具のシルエット程度)。時間帯で空の色が変わる
- スマホ幅(375px〜)優先のレスポンシブ。PC では中央 480px カラム
