# いっしょぐらし — 設計書

キャラクターと一緒に暮らしながら、日々のタスクをこなしてモチベーションを保つゲーム。
恋愛シミュレーション+育成ゲームの雰囲気。タスク達成でコインが貯まり、プレゼントやデートに使える。

## 技術方針

- バニラ JS / HTML / CSS のみ。ビルドツール・外部依存・外部通信なし。`file://` で開いても動くこと
- 永続化は `localStorage` キー `isshogurashi_v1`(JSON 一括保存)
- UI は日本語。ユーザー入力は必ずエスケープして表示(XSS 対策。`textContent` か専用 `esc()` を使う)
- スクリプト読み込み順: `js/character.js` → `js/gamedata.js` → `js/dialogue.js` → `js/focusflow.js` → `js/app.js`
- 各ファイルは `window.*` のグローバル名前空間 1 つだけを公開する

## ファイル構成と担当

| ファイル | 内容 | 公開名 |
|---|---|---|
| `index.html` | 全画面の DOM 骨格 | — |
| `style.css` | 全スタイル | — |
| `js/character.js` | SVG 立ち絵レンダラー | `CharacterArt` |
| `js/gamedata.js` | 経済・レベル・プレゼント・デートの定義データ | `GameData` |
| `js/dialogue.js` | セリフエンジン+セリフデータ | `Dialogue` |
| `js/focusflow.js` | FocusFlow タスクシステム移植版 | `FFX` |
| `js/app.js` | 状態管理・画面遷移・報酬・UI ロジック | `App` |

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
      outfitStyle: 'dress',                  // OUTFIT_STYLES のいずれか
      accessory: 'none'                      // ACCESSORIES のいずれか
    }
  },
  affection: 0,                              // 親密度(累積、減らない)
  coins: 0,
  params: { int, fit, life, sense, grit },   // 自分のパラメーター(ときメモ式)
  streak: { current: 0, best: 0, lastAllDoneDate: null },  // 'YYYY-MM-DD'
  tasks: [],                                 // 旧形式 (移行後は常に空。タスクは ff-tasks へ)
  roster: [{ id, character, affection, memories }],  // 控えのキャラクター (複数キャラ)
  ff: { enabled, initialized, migrated, rewardedIds: [] },  // FocusFlow 統合の管理
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
CharacterArt.HAIR_STYLES    // 10種: short, pixie, bob, long, wavy, hime, twintail, ponytail, buns, braids
CharacterArt.ACCESSORIES    // 8種: none, ribbon, glasses, flower, catears, hairpin, beret, earring
CharacterArt.OUTFIT_STYLES  // 5種: dress, hoodie, sailor, blazer, yukata (look.outfitStyle)
CharacterArt.EXPRESSIONS    // ['normal','smile','joy','blush','pout','sad','surprised','sleepy']
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
3. **タスク**: FocusFlow 移植版(上記「FocusFlow 統合」参照)。完了時はコイン・親密度付与+キャラのリアクション
4. **プレゼント**: GIFTS のショップ。購入→キャラのリアクション(reactions から抽選、表情 joy/blush)+memories 記録
5. **おでかけ(デート)**: DATE_SPOTS 一覧(価格と必要レベル、未達はロック表示)。選ぶと全画面のビジュアルノベル風シーン: 背景(bgClass)+立ち絵+script をクリックで送る → 終了後 affection 付与+memories 記録
6. **きろく**: レベル(進捗バー)、ストリーク、累計統計、思い出タイムライン(memories)
7. **せってい**: キャラの見た目・性格・名前・話し方の再編集、データリセット(要確認)

## ゲームロジック要点(app.js)

- **完了処理**: コイン・親密度付与 → 吹き出しに `task_complete` → 全タスク完了なら続けて `all_done` +ボーナス+ストリーク更新(`lastAllDoneDate` が昨日なら current+1、それ以外は 1)
- **レベルアップ検知**: 親密度付与のたびに `levelFor` の変化を見て、変化したら `levelup` セリフ+お祝い演出+memories 記録
- **日付ロールオーバー**(起動時と `visibilitychange` で判定): `lastVisit` と今日が違えば、繰り返しタスクの `done` をリセット(曜日指定は該当曜日のみ表示対象)。単発タスクの完了済みは非表示化(アーカイブ)。2 日以上空いていたら挨拶を `comeback` に差し替え
- **表情の使い分け**: 通常 normal/smile、完了 joy、プレゼント joy/blush、has_overdue は pout/sad、夜 sleepy など状況に連動

## FocusFlow 統合(js/focusflow.js)

**FocusFlow**(`piinatsu123-tech/focusflow1` v5.2)のタスクシステムを丸ごと移植し、
タスク管理を完全に統合した。「タスク」タブの中身は FocusFlow の UI そのもの。

- **移植範囲**: メイン画面(タイムバー+緊急度グループ)、すべてタブ(期日タイムライン+
  削除モード)、グループ詳細(スワイプ削除)、集中モード(タイマーリング+ステップ進行)、
  タスク/ステップ編集画面、アクションシート、LINE ボット取り込み(Worker `/tasks`)、
  Worker `/sync` 同期、クリップボード JSON インポート
- **名前空間**: クラス/ID の衝突回避に `ffx-` プレフィックス
  (`screen`→`ffx-screen` 等 6 クラス+画面 ID)。CSS 変数は `.ffx` スコープで上書き。
  公開 API は `window.FFX`(inline onclick と app.js 連携用)
- **データ**: localStorage `ff-tasks`(FocusFlow と同一形式
  `{id, title, done, urgency: must|want|nice|scheduled, steps, estimate, dueDate?, scheduledDate?}`)。
  いっしょぐらし独自のタスクモデルは廃止し、初回起動時に未完了分を自動移行
  (difficulty hard→must / normal→want / easy→nice。`state.ff.migrated`)
- **追加機能**: ヘッダーの「＋追加」ボタンから新規タスク作成(本家は LINE 取り込みのみ)。
  タイトル未入力で戻ったら破棄
- **報酬経路の一元化**: FFX の `save()` が毎回 `App.onTasksChanged()` を呼ぶ →
  `ffCheckExternalCompletions()` が rewardedIds との差分で新規完了を検知して
  コイン・親密度付与+キャラのリアクション。アプリ内完了・集中モード完了・
  LINE 取り込み後の完了・別タブからの完了がすべて同じ経路で処理される
- **報酬マッピング**: must→hard / want→normal / nice→easy(ECONOMY 準拠)。
  新規タスク追加時は `task_add` のセリフで反応
- **全完了判定**: 非 scheduled のタスクが 1 件以上あり全部 done。
  `handleAllDone` は同日 2 回目以降は何もしない
- **ホーム**: クイックリストに未完了タスク(非 scheduled)を緊急度バッジ付きで表示。
  チェックは `FFX.toggleDone()` 経由

## 複数キャラクター(ロスター)

複数のキャラクターを保存して切り替えられる。

- **データ**: アクティブキャラは従来どおり `state.character` / `affection` / `memories`
  に展開(既存コードは無変更で動く)。控えは `state.roster` に
  `{id, character, affection, memories}` で保存。**親密度と思い出はキャラごと**、
  コイン・パラメーター・ストリーク・タスクは共有
- **上限**: アクティブ含め 6 人(`ROSTER_MAX`。customArt の localStorage 容量を考慮)
- **せってい「キャラクター」セクション**: サムネ+名前+レベル+親密度の一覧。
  「交代」でスワップ(挨拶は親密度 0 なら `setup_first`、それ以外は `comeback`)、
  🗑️ で確認ダイアログ付きのお別れ
- **「＋あたらしい子をつくる」**: セットアップウィザードを追加モードで再利用
  (`wizardMode='add'`)。完了時にいまの子を控えへ、新しい子は親密度 0 から。
  「← やめてもどる」でキャンセル可(状態は無変更)
- **チャットインポートとの連携**: せっていからのインポートはデフォルトで
  「新しい子として迎える」(いまの子は自動で控えに、呼ばれたい名前は引き継ぐ)。
  「いまの子を上書きする」チェックで従来の置き換えもできる
- 確認ダイアログは汎用化(`showConfirm(title, msg, okLabel, cb)`)

## キャラクターインポート(チャット相談・フルカスタム対応)

AI チャットで相談して作ったキャラクターを JSON で取り込める。
プリセット(5 性格×パーツ組合せ)だけでなく、**性格=セリフ集ごと自作**・
**見た目=SVG 絵ごと自作**のフルカスタムに対応。

### フルカスタム性格

- JSON: `personality: "custom"` + `personalityLabel`(表示名)+
  `basePersonality`(プリセットのどれか)+ `dialogue`(セリフ集)
- `dialogue[situation]` は文字列配列(全 tier 共通)or `{low,mid,high}`。
  12 場面+`gift_reaction`({gift} 可)+`praise.{int,fit,life,sense,grit}`
- 書いた場面だけカスタムが使われ、無い場面とデート VN は basePersonality に
  フォールバック(`Dialogue.resolvePersonality`)
- プリセット personality + dialogue 同時指定は「プリセット改」として custom 扱い
- 検証: 1 行 200 文字・1 プール 10 本まで。表示は textContent 経由で XSS 安全
- せってい/ウィザードの性格グリッドに「💎 (ラベル)」カードが追加され、
  プリセットとカスタムを行き来できる(カスタムデータは保持)

### 画像アップロード立ち絵

- せってい/ウィザードの「📷 画像から作る」で任意の画像ファイルを立ち絵にできる
  (AI 生成イラスト・手描き・写真など何でも)
- canvas で最大 400×520 にリサイズ → dataURL (PNG、重ければ JPEG 0.85)。
  900KB 超は拒否。`data:image/(png|jpeg);base64,...` の形式検証をして
  `state.character.customArt = { dataUrl }` に保存
- 「↩️ パーツ編集に戻す」で customArt を消してパラメトリック表示に戻せる
  (SVG インポートの取り消しにも使える)

### フルカスタム立ち絵 (SVG)

- JSON: `svg`(viewBox 0 0 200 260)+任意の `svgExpressions`(表情差分。
  無い表情は base を使う)
- **サニタイズ必須**: `sanitizeSVG()` が許可リスト方式で要素
  (path/circle/rect/polygon/g/defs/gradient 等)と属性のみ通す。
  script・image・foreignObject・on* 属性・外部 URL・`url()`(内部 `#id` 参照以外)は
  除去。100KB 上限。サニタイズ済み文字列を `state.character.customArt` に保存し、
  描画時はそのまま innerHTML(再検証不要)
- `renderChara()` が customArt を優先描画(ホーム/VN/レベルアップ/せってい共通)。
  パラメトリック look はフォールバックとして保持

### 共通

- **相談用プロンプト**: せっていの「📋 相談用プロンプト」でコピー。スキーマと選択肢
  (性格 5 種・髪型・アクセ・色形式・文字数制限)は `CharacterArt`/`PERSONALITY_NAMES`
  から動的生成するので、データを増やせばプロンプトも追従する
- **JSON 形式**: `{ name, personality, firstPerson, callName, suffix, look: {...} }`
  (state.character と同形。callName は省略可=現状維持)
- **取り込み口**: せっていの「📥 インポート」(即反映してホームで挨拶)と、
  セットアップウィザード Step1 のリンク(ウィザードに流し込んで Step3 の名前確認へ)
- **入力の揺れ吸収**: スマート引用符の正規化+最初の `{`〜最後の `}` 抽出
  (コードフェンスや前後の文章ごと貼って OK)。FocusFlow のインポートと同じ思想
- **検証**: personality/hairStyle/accessory はホワイトリスト、色は `#hex` のみ
  (SVG に埋め込むため厳格に)、名前系は文字数クランプ。エラーは日本語で列挙して
  チャットに修正依頼しやすくする
- **プレビュー**: 貼り付けと同時に立ち絵+性格+その子の声のサンプル
  (`setup_first` を語尾・一人称適用で)を表示し、「この子をむかえる」で確定。
  コイン・親密度・パラメーター等の進行データは維持される

## 自分のパラメーター(ときメモ式)

タスク完了で「自分」のパラメーターが上がる成長システム。コイン・親密度と併存する第三の軸。

- **5 種**: 知性📚 / 体力💪 / 生活力🏠 / 感性🎨 / 根性🔥(`GameData.PARAMS`)
- **上昇量**: 緊急度依存 `PARAM_GAIN = { must: 3, want: 2, nice: 1 }`
- **カテゴリ決定**: タスク編集画面のカテゴリチップ(手動)>
  `GameData.classifyTask(title)` のキーワード自動分類(LINE 取り込み等)> フォールバック根性。
  ff-task に `category` フィールドとして保存
- **褒めセリフ**: `Dialogue.praise(paramId, state)`。
  `PARAM_PRAISE[personality][paramId]`(5×5×2 本)。単独完了の 40% で task_complete の代わりに使う
- **見える化**: きろくに SVG レーダーチャート(5 角形・3 リング目盛・軸は 10 刻み自動スケール)
  +バー付き一覧
- **デート解放条件**: `DATE_SPOTS[].statReq = { param, value }` をレベル条件と併用。
  映画館=感性3、水族館=知性6、遊園地=体力10、温泉旅行=生活力15。
  ロック表示は「🎨感性3で解放」、`startDate` でも再ガード
- **トースト**: 報酬表示にパラメーター上昇を併記(例 `🪙+40 ✨+8 💪+3`)

## ビジュアルトーン

- 暖かみのあるパステル系。角丸大きめ、影は柔らかく。フォントは system-ui 系で可
- 部屋背景は CSS のみで描く(窓+グラデの空、家具のシルエット程度)。時間帯で空の色が変わる
- スマホ幅(375px〜)優先のレスポンシブ。PC では中央 480px カラム
