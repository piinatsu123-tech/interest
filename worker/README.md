# Worker (LINE ボット + AI タスク分解)

FocusFlow の LINE 連携を担う Cloudflare Worker。

- LINE の Webhook を受け、テキスト/画像を **Claude API でタスクに分解**して KV に貯める
- **写真＋文章**: 写真だけだと解析の精度に限界があるので、文章で補える。
  写真を送ったあと 5 分以内に `補足: 床だけでいい` と送ると、その指示を最優先に
  **解析し直して前回の結果を置き換える**（先に `写真: 〜` を送ってから撮る方法もある）
- アプリ側 (`js/focusflow.js` の `importFromLine()`) が `/tasks` を GET して取り込む
- 毎朝 6:00 JST に定期タスクを投入し、その日が実行日のタスクを LINE に通知 (Cron)
- 「一覧 / 定期登録 / 休日登録」などのコマンドに応答
- **汚れの記録**: `記録！ ふきこぼれ` で、タスクにせず記録だけ残す。「どの場面で汚れるか」を
  実データで把握し、道具の置き場所などの環境側の対策を打つのが目的（習慣化したら記録をやめてよい）
  - `記録一覧` … 多い順に集計（**全期間**）。`記録一覧 2週間` / `1ヶ月` / `30日` で期間指定
  - `記録詳細` … 日付ごとに一覧。件数だけでは分からない「毎日なのか特定の日に固まるのか」を見る
  - 保存は1件ずつ `{text, 日付}` で直近1000件。期間は集計時にかけるだけなので、
    あとから範囲を広げても過去分は失われない

| ファイル | 内容 |
|---|---|
| `worker.js` | Worker 本体 |
| `wrangler.toml` | Worker 名・KV バインディング・Cron の設定 |

### プロンプトを触るときの注意

実際に踏んだ落とし穴。直すときはここを先に確認する。

- **画像に添える指示文 (`DEFAULT_IMAGE_INSTRUCTION`) はシステムプロンプトより強く効く。**
  ここを「片付け・掃除が必要な箇所」と書いていたせいで、システムプロンプトに
  「汚れた物は移動する前に洗う」と逐語で書いてあっても洗い物が出てこなかった。
  枠付けの言葉を狭めない
- **ルールを足すほど他が緩む。** 3000文字近くまで膨らんだ時点で、明示した禁止語
  すら守られなくなった。足すより、重複を消して短く保つ
- **同じルールを2箇所に書かない。** 共通ルールと画像ルールの両方に書くと表現が
  ぶれる。画像ブロックは共通ルールへの追加分だけにする
- **「同じ種類・同じ場所のものは1step」のような条件の足し過ぎに注意。**
  「同じ場所の」と書いたせいで、場所が違えば分けてよいと解釈され、
  シンク内とシンク右側で step が分裂した
- プロンプトを変えたら `prompt-coverage-test` 相当の確認をすること。
  過去に直した不具合のルールを消していないか、文言ベースで点検できる

### 画像解析の精度を上げたいとき

`worker.js` の `MODEL_IMAGE` を変えるだけ（文章側の `MODEL_TEXT` は別なので影響しない）。

| モデル | 画像の最大解像度 | 料金 | 写真1枚あたり |
|---|---|---|---|
| `claude-haiku-4-5`（現在） | 長辺 1568px | $1 / $5 per MTok | 約 1.4 円 |
| `claude-sonnet-5` | 長辺 2576px | $3 / $15 per MTok | 約 5.5 円 |

散らかった部屋の写真で「写っていない物を挙げる」のが減らない場合、原因はたいてい解像度なので
プロンプトより先にここを疑う。なお **`temperature` は Sonnet 5 / Opus 5 では非デフォルト値が
400 エラーになる**ので、ハルシネーション対策に使えない（プロンプト側で接地させる）。

デプロイは `.github/workflows/deploy-worker.yml` が担当し、**`worker/` 配下を変更して
main に push すると自動でデプロイ**される。フロント (GitHub Pages) のデプロイとは独立。

---

## 初回だけ必要なセットアップ

自動デプロイを有効にするには、次の 4 つを一度だけ設定する。

### 1. `wrangler.toml` の `FILL_ME_IN` を埋める

残っているのは KV の `id` だけ。`name` は既存 Worker の URL から判明済み
(`https://divine-wildflower-8952.piinatsu123.workers.dev` → `divine-wildflower-8952`)。

| 項目 | どこで確認するか |
|---|---|
| `[[kv_namespaces]]` の `id` | Cloudflare → Storage & Databases → **KV** → 対象ネームスペースの **Namespace ID**<br>または `npx wrangler kv namespace list`(要 `wrangler login`) |

> ❗ **`name` は既存の Worker と完全一致していること。** 違う名前でデプロイすると
> 別の新しい Worker が作られ、LINE の Webhook 先は古い Worker のままなので
> **ボットが無反応になる**。初回デプロイ前に Workers & Pages の一覧に
> `divine-wildflower-8952` があることを目視で確認しておくと確実。

### 2. Cloudflare の API トークンを作る

Cloudflare → 右上のアカウントメニュー → **API Tokens** → *Create Token* →
テンプレート **"Edit Cloudflare Workers"** を使うのが簡単。作成後のトークン文字列は
一度しか表示されないのでコピーしておく。

アカウント ID は Workers & Pages の画面右側、または URL
`https://dash.cloudflare.com/<ここがアカウントID>/...` から取得できる。

### 3. GitHub にシークレットを登録する

GitHub のリポジトリ → **Settings** → *Secrets and variables* → **Actions** →
*New repository secret* で 2 つ登録:

| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 手順 2 で作ったトークン |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |

### 4. Worker のシークレットが「Secret」になっているか確認する

Cloudflare → 対象 Worker → **Settings** → *Variables and Secrets* を開き、
次の 3 つが **Secret**(暗号化・値が伏せ字)になっていることを確認する。

- `ANTHROPIC_API_KEY`
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`

Secret であればデプロイしても消えない。もし平文の **Variable** になっている場合は、
`wrangler.toml` に書いていないため**デプロイ時に消える可能性がある**。その場合は
Secret として登録し直しておく (CLI なら `npx wrangler secret put ANTHROPIC_API_KEY`)。

---

## 初回デプロイの手順(安全側)

いきなり push せず、手動実行で 1 回確かめるのがおすすめ。

1. 上の 1〜4 を済ませて main に push する
   (この時点ではワークフローは走るが、`FILL_ME_IN` が残っていればガードで停止する)
2. GitHub の **Actions** タブ → *Deploy Worker to Cloudflare* → **Run workflow** で手動実行
3. 成功したら LINE で「一覧」と送って応答を確認する
4. 以降は `worker/` を変更して push するだけで自動デプロイされる

## うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| Actions がガードで停止する | `wrangler.toml` に `FILL_ME_IN` が残っている |
| `Authentication error` | `CLOUDFLARE_API_TOKEN` の権限不足。"Edit Cloudflare Workers" テンプレートで作り直す |
| デプロイは成功するが LINE が無反応 | `name` が既存 Worker と違い、新しい Worker が作られた。ダッシュボードで Worker 一覧を確認し、`name` を修正して再デプロイ |
| `KV namespace ... not found` | `[[kv_namespaces]]` の `id` が違う |
| デプロイ後に API キーのエラー | シークレットが平文 Variable だった可能性。Secret として登録し直す |

## ロールバック

Cloudflare → 対象 Worker → **Deployments** から以前のバージョンに戻せる。
`compatibility_date` を変えた場合は挙動が変わりうるので、まずそこを疑う。

## ローカルから直接デプロイしたい場合

```sh
cd worker
npx wrangler deploy          # 本番へ反映
npx wrangler deploy --dry-run # 何が起きるかだけ確認 (反映しない)
npx wrangler tail            # 本番のログをリアルタイムで見る
```
