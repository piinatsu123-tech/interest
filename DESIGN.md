# FocusFlow — 設計書

タスク管理アプリ。緊急度別のタスク管理(FocusFlow)、その場で発生した家事を
その場で片付けるフロー(FlowClean = そうじ)、期限切れタスクの棚卸しの 3 本柱。

> **履歴**: 本アプリは元々「いっしょぐらし」というキャラクター育成ゲーム
> (お部屋・立ち絵・セリフ・コイン/親密度/レベル・プレゼント・おでかけ・きろく)
> にタスク管理を組み込んだものだった。その育成レイヤーは不要と判断して全削除し、
> タスク管理に特化した。削除前の完全なコードは **`archive/isshogurashi` ブランチ**
> (ローカルタグ `v1-isshogurashi`)に保存してあり、いつでも参照・復元できる。

## 技術方針

- バニラ JS / HTML / CSS のみ。ビルドツール・外部依存なし。`file://` で開いても動くこと
  (唯一の外部通信は focusflow.js の Worker への `/sync`・`/tasks`。失敗しても握り潰す)
- 永続化は `localStorage`。タスク本体は `ff-tasks`、そうじの設定は `fc_*`、
  日付ロールオーバー用の `lastVisit` だけ `isshogurashi_v1`(キー名は歴史的経緯で据え置き)
- UI は日本語。ユーザー入力は必ずエスケープして表示(XSS 対策。`textContent` か `esc()`)
- スクリプト読み込み順: `js/focusflow.js` → `js/flowclean.js` → `js/triage.js` →
  `js/core.js` → `js/main.js`(**main.js は最後**=`init()` を持つ)
- `focusflow.js` / `flowclean.js` は IIFE で `window.FFX` / `window.FC` だけを公開。
  `triage.js` は `window.Triage`、`core.js` + `main.js` はスクリプトスコープを共有し
  `window.App` を公開する

## ファイル構成と担当

| ファイル | 内容 | 公開名 |
|---|---|---|
| `index.html` | 全画面の DOM 骨格 | — |
| `style.css` | 全スタイル(共通 + `.ffx` タスク + `.fc` そうじ + 棚卸し) | — |
| `js/focusflow.js` | タスクシステム(一覧・グループ・集中モード・編集・手番の並べ替え) | `FFX` |
| `js/flowclean.js` | そうじタブ(状態→イベント→ステップの家事フロー) | `FC` |
| `js/triage.js` | 期限切れタスクの棚卸し | `Triage` |
| `js/core.js` | `esc`/`todayStr`/`showToast`・`lastVisit` の保存・日付ロールオーバー・確認ダイアログ・リセット | (App 層) |
| `js/main.js` | 画面切替・イベント登録・`init()`(**最後に読み込む**) | `App` |

## 状態スキーマ(localStorage)

```js
// 'ff-tasks' — タスク本体 (focusflow.js)
[{ id, title, done, urgency: 'must'|'want'|'nice'|'scheduled',
   steps: [{ text, done, estimatedMinutes }], estimate,
   dueDate?, scheduledDate?, order }]

// 'isshogurashi_v1' — 日付ロールオーバー用 (core.js)
{ version: 2, lastVisit: 'YYYY-MM-DD'|null }

// 'fc_states' / 'fc_env_list' / 'fc_reward_images' / 'fc_reward_msgs' — そうじ (flowclean.js)
```

`resetData()` はこれら全部(`ff-tasks`・`isshogurashi_v1`・`fc_*`)を消してリロードする。

## 画面構成

SPA。画面は 2 つだけ。

- **`#tab-tasks`** — メイン。上部タブ(`FFX.switchTab`)で **タスク / すべて / そうじ** を切り替える
  1. **タスク**: ダッシュボード(今日の残り時間バー + 緊急度グループ)。起動時はここに着地。
     グループをタップすると `#ffx-screen-group` が開き、タスクをタップすると集中モード
  2. **すべて**: 期日タイムライン + 全タスク一覧(緊急度の付け替え・削除)
  3. **そうじ**: FlowClean の家事フロー。`＋追加` ボタンは隠す
- **`#tab-settings`** — ヘッダー右上の ⚙ から開き、`‹` で戻る。棚卸しの手動起動とデータリセットのみ

オーバーレイ: グループ詳細 / 集中モード / タスク編集 / ステップ編集 / アクションシート
(すべて `.ffx-screen`)、棚卸し(`#triage-overlay`)、確認ダイアログ(`#confirm-overlay`)。

下部タブバーは廃止(育成レイヤーのハブだったため)。タスク画面が画面下端まで使える。

## FocusFlow 統合(js/focusflow.js)

**FocusFlow**(`piinatsu123-tech/focusflow1` v5.2)のタスクシステムを丸ごと移植し、
タスク管理を完全に統合した。「タスク」タブの中身は FocusFlow の UI そのもの。

- **移植範囲**: メイン画面(タイムバー+緊急度グループ)、すべてタブ(期日タイムライン+
  削除モード)、グループ詳細(スワイプ削除)、集中モード(タイマーリング+ステップ進行)、
  タスク/ステップ編集画面、アクションシート、LINE ボット取り込み(Worker `/tasks`)、
  Worker `/sync` 同期、クリップボード JSON インポート
- **名前空間**: クラス/ID の衝突回避に `ffx-` プレフィックス
  (`screen`→`ffx-screen` 等 6 クラス+画面 ID)。CSS 変数は `.ffx` スコープで上書き。
  公開 API は `window.FFX`(inline onclick と `triage.js` 連携用)
- **データ**: localStorage `ff-tasks`(FocusFlow と同一形式に `order` を追加した
  `{id, title, done, urgency: must|want|nice|scheduled, steps, estimate, dueDate?, scheduledDate?, order}`)
- **今日中(must)タスクの手番の順番**: グループ詳細画面(`#ffx-screen-group`)で
  `currentUrgency === 'must'` の時だけ、未完了タスクに ①②③...(タスク名 17px より
  大きい 26px の実際の丸数字 Unicode 文字。`circledNumber()`、21 件目以降は
  `(21)` 表記にフォールバック)を表示。`t.order`(数値、`migrateTasks()` で無ければ
  配列位置を初期値に)で昇順ソート
  - **通常時**: 番号を見るだけ。カードをタップすると従来通り集中モードが開く
  - **「編集」ボタン**(ヘッダー右上、must の時だけ表示)を押すと編集モードに入り、
    ボタンは「完了」に変わる。編集中はタップした順に番号が振られていく方式
    (▲▼ボタンではない)。まだ振っていないタスクは番号の代わりに薄い「○」を表示、
    タップ済みのカードは不透明な薄いピンク背景でハイライト(`.reorder-tapped`。
    **半透明色は使わない** — カードの下には常にスワイプ削除用の赤い背景が敷かれて
    おり、`rgba()` で透明度を付けるとその赤が透けて見えてしまう実装上の落とし穴が
    あるため)。同じタスクを再タップすると最後尾に振り直される
  - 「完了」を押す(または編集中に戻るボタンで抜ける)と `finalizeReorder()` が
    タップ順に `order` を確定して保存。タップされなかったタスクは元の相対順の
    まま後ろに続く。`addTask()` は新規タスクに既存最小 order−1 を割り当てる
    (常に一覧の先頭に来る、旧 `unshift` の見た目を維持)
  - want/nice/scheduled には番号・編集ボタンとも出さない
- **追加機能**: ヘッダーの「＋追加」ボタンから新規タスク作成(本家は LINE 取り込みのみ)。
  タイトル未入力で戻ったら破棄
- **育成レイヤー削除で外したもの**: タスク完了時のコイン/親密度付与とキャラのリアクション
  (`App.onTasksChanged` / `onUserCompletedTask` の呼び出し)、タスクのカテゴリ
  (ときメモ式パラメーター)選択 UI、お部屋タブ(`room`)への切り替え。完了はローカルに
  保存されトーストが出るだけになった

## FlowClean 統合(js/flowclean.js)

**FlowClean**(`piinatsu123-tech/flowclean` v2.0)の家事フローツールを丸ごと移植し、
上部タブ **タスク / すべて / そうじ** の3つめとして統合した。「今、何してる?」(状態) →
「何が起きた?」(イベント) → 1 個ずつタップで進める小さなステップ、という
FocusFlow のタスク一覧とは全く異なる「その場で発生した家事をその場で片付ける」ための
ツール。データ・操作感ともタスク管理とは独立している。

- **移植範囲**: 状態一覧(料理中/デスク作業/食事中/帰宅/就寝前/洗濯の 6 種)、
  イベント一覧、事前確認(defer)画面、1 ステップずつ進めるフロー画面、
  完了画面+ご褒美画像/メッセージのランダムポップアップ、状態・イベント・ステップの
  編集画面、環境マップ({変数}→道具の場所)設定、効果音(Web Audio 生成)
- **名前空間**: クラス/ID の衝突回避に `fc-` プレフィックス。CSS 変数は `.fc`
  スコープ(`--fc-bg` 等)で定義し、`:root` や `.ffx` の変数と衝突しない。
  公開 API は `window.FC`(index.html 側の onclick 委譲と `FFX.switchTab('fc')` 連携用)。
  そうじタブは FocusFlow の `.ffx-embed` 内(`#ffx-tab-fc` > `#fc-app`)に同居するため
  `.ffx, .ffx * { padding:0; margin:0 }` のリセットを受けるが、`.fc-*` の各ルールは
  スタイルシート上で `.ffx` ブロックより後ろにあり同じ詳細度なので後勝ちで正しく効く
  (詳しくは後述の「ビジュアルトーン → 実装上の落とし穴」参照)
- **データ**: localStorage `fc_states`(カスタム状態/イベント。未設定ならコード内蔵の
  既定 6 状態を使用)・`fc_env_list`(道具の場所)・`fc_reward_images`(Base64 JPEG、
  アップロード時に長辺 1080px にリサイズ)・`fc_reward_msgs`。旧サイト
  (flowclean 単体アプリ)の localStorage はオリジン(ドメイン)が違うため自動移行はできない
- **セキュリティ**: 元コードは `fill()`(ステップ本文の `{変数}` 展開)が未エスケープの
  まま `innerHTML` に渡っており、道具の場所やステップ本文に HTML を仕込むと
  実行されてしまう脆弱性があった。移植時に `fill()` を「本文と変数値を両方 `esc()` して
  から `{変数}` を置換する」実装に修正済み
- **完了時**: ご褒美画像を登録していればランダムに 1 枚ポップアップ表示(メッセージを
  登録していれば重ねて表示)、無ければ完了画面を 1.8 秒見せて自動でホームに戻る。
  育成レイヤー削除に伴い、コイン/親密度の付与とキャラのリアクション
  (`App.rewardChoreComplete` / `App.showChoreReaction`)は廃止した
- **そうじタブでは「＋追加」ボタンを隠す**(タスク管理用ボタンのため)

## 期限切れタスクの棚卸し(js/triage.js)

期限切れタスク(`dueDate` が今日より前・未完了)が優先度グループに埋もれたまま
放置される問題への対策。**毎日最初のアクセス時**に、期限切れタスクが 1 件でも
あればタスク画面に進む前に強制的にトリアージ画面を挟む。ゼロ件の日は
何も表示されず、通常のフローと完全に同じ体感。

- **トリガー**: `doRollover()`(core.js)が `{ isNewDay }` を返す。`isNewDay` は
  「その日初めてのアクセスか」を表し、同日中の再訪問では常に `false`
  (トリアージは 1 日 1 回だけ)。`main.js` の `init()` と `visibilitychange`
  ハンドラの両方で、`isNewDay` かつ `window.Triage` があれば `Triage.maybeStart()`
  を呼ぶ。期限切れが無ければ即座に終了するので何も表示されない
- **画面**: `#triage-overlay`(不透明度低めの黒背景+中央カード)。
  「今日、これどうする？」のような説明文は置かず、進捗(`n / 合計`)+
  タスクカード+選択肢のみのミニマルな構成。期限切れタスクを 1 件ずつカード表示し、
  すべてワンタップ(日付選択のみ OS のネイティブ日付ピッカーが挟まる):
  - **今日** → `FFX.triageTaskToday(id)` で優先度を `must` に。**`dueDate` は動かさない**
    ので、その日のうちに終わらなければ翌日また棚卸しの対象になる
  - **明日／来週** → `FFX.triageDeferTask(id, newDate)` で `dueDate` を延長(クイック用)
  - **日付を選ぶ** → 透明な `<input type="date" min=今日>` を実サイズで重ねたチップ。
    タップで OS のネイティブ日付ピッカーが開き、選択した任意の日付に `dueDate` を
    延長できる(`change` イベントで即反映、確認ステップなし)
  - **削除** → `FFX.triageDeleteTask(id)` で即削除(タスクのスワイプ削除と
    同じく確認ダイアログ無し。棚卸しは「全部ワンタップ」を維持するため)
  - **あとで** → 何もせず次のカードへ(そのタスクは翌日また対象になる)
- **「強制」の設計**: 完全ブロッキングだが、「あとで決める」で個々の判断は先送りできる。
  溜まった期限切れの多さでユーザーを罰しない(実行力を削がないため)一方、
  存在を毎日必ず一度は目にする設計
- **公開 API**: `window.Triage.maybeStart(afterDone)` のみ。タスクデータの読み書きは
  すべて `FFX.getOverdueTasks()` / `triageTaskToday` / `triageDeferTask` /
  `triageDeleteTask`(focusflow.js に実装、`window.FFX` 経由で公開)を介す

## ビジュアルトーン

- **ニュートラル基調**。背景 `#FAFAF8`、カード白、文字 `#1a1a1a`、境界線は細い `#e8e8e8`、
  フォントは `Noto Sans JP`。シンプルで視認性優先
- 差し色は控えめなローズ 1 色(`--accent: #d96a8c`)と、緊急度 must の赤(`--must: #d94f4f`)
- 配色は `:root` の CSS 変数に集約。`.ffx`(タスク)と `.fc`(そうじ)はそれぞれ独自の
  スコープ変数を持ち、互いに干渉しない
- 角丸・影は控えめ(`--r-sm/md/lg = 8/12/16px`、影は薄いグレー)
- スマホ幅(375px〜)優先のレスポンシブ。PC では中央 480px カラム

### 実装上の落とし穴

- **`.ffx` / `.fc` の `* { padding:0; margin:0 }` リセット**: これらのスコープ内に新しい
  UI を足すとき、余白が効かないことがある。同じ詳細度なら**スタイルシート上で後ろに
  書いたルールが勝つ**ので、`.ffx` ブロックより後方に置くか、ID 指定など詳細度を上げる
- **タスクカードの半透明背景は禁止**: カードの下には常にスワイプ削除用の赤い背景
  (`.delete-bg`)が敷かれているため、`rgba()` で透明度を付けるとその赤が透けて見える。
  ハイライトは必ず不透明色で指定する(`.reorder-tapped` がこの例)
