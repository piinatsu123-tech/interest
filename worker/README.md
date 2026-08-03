# Worker (LINE ボット + AI タスク分解)

FocusFlow の LINE 連携を担う Cloudflare Worker。

- LINE の Webhook を受け、テキスト/画像を **Claude API でタスクに分解**して KV に貯める
- **写真＋文章**: 写真だけだと解析の精度に限界があるので、文章で補える。
  写真を送ったあと 5 分以内に `補足: 床だけでいい` と送ると、その指示を最優先に
  **解析し直して前回の結果を置き換える**（先に `写真: 〜` を送ってから撮る方法もある）
- アプリ側 (`js/focusflow.js` の `importFromLine()`) が `/tasks` を GET して取り込む
- 毎朝 6:00 JST に定期タスクを投入し、その日が実行日のタスクを LINE に通知 (Cron)
- 「一覧 / 定期登録 / 休日登録」などのコマンドに応答
- **汚れの記録**: `記録！ ふきこぼれ` で、タスクにせず記録だけ残す。`記録一覧` で
  直近2週間を多い順に集計。「どの場面で汚れるか」を実データで把握し、道具の
  置き場所などの環境側の対策を打つのが目的（習慣化したら記録をやめてよい）

| ファイル | 内容 |
|---|---|
| `worker.js` | Worker 本体 |
| `wrangler.toml` | Worker 名・KV バインディング・Cron の設定 |

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
