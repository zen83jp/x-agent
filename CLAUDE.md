# X エージェントチーム（代表アカウント運用）

## 目的
株式会社Colors 代表のXアカウントについて、以下を半自動化する。
1. 見込み客からのDMへの一次対応と商談化（最優先）
2. 投稿案の作成・審査・承認後の予約投稿
3. 投稿パフォーマンスの分析と、投稿案作成へのフィードバック

## 技術スタック
- ランタイム: Vercel（Next.js App Router / Route Handlers + Vercel Cron）
- DB: Supabase（Postgres）。スキーマは `supabase/schema.sql`
- LLM: Claude API（Anthropic SDK）。プロンプトは `prompts/` 配下のMarkdownを読み込んで使う
- X: X API v2（OAuth 2.0 PKCE / user context）。スコープ: tweet.read tweet.write users.read dm.read dm.write offline.access
- 通知・承認: Slack（Block Kit のボタンで承認／修正／却下）。送り先はチャンネル1つ（`SLACK_CHANNEL_ID`）で、先頭の【DM承認】【投稿承認】【アラート】で種類を区別する

## 絶対ルール
- **人の承認なしに投稿しない。** `post_drafts.review_status = 'approved'` のものだけ投稿する
- **DMは `dm_auto_reply_enabled` フラグが false の間は全件Slack承認後に送信する**（初期値 false）
- 自動返信が許可されていても、カテゴリが `faq` かつ confidence >= 0.85 のものだけ自動送信する
- 本文にURLを含む投稿は作らない（1件$0.20のため）。URLが必要な場合は警告してSlackに回す
- X APIの呼び出しはすべて `x_api_usage` テーブルに記録し、日次の上限（環境変数 `X_DAILY_BUDGET_USD`）を超えたら停止してSlackに通知する
- 同じDMスレッドへの自動返信は24時間で1回まで。こちらから新規DMを送る機能は作らない
- APIキー・トークンは環境変数のみ。リポジトリにコミットしない

## 実装フェーズ（この順で進める）
### Phase 1: 土台
- Supabaseスキーマ適用、X OAuth（代表アカウントでの認可とrefresh token保存）
- Slack通知とボタン操作のRoute Handler（`/api/slack/interact`）
- X API呼び出しの共通ラッパー（使用量記録・予算チェック込み）

### Phase 2: DM（承認モード）
- **暗号化DMについて**: エンドツーエンド暗号化された会話は `GET /2/dm_events` に出てこない（取得できるのは旧形式のDMのみ）。扱うには X Chat API での復号が必要だが、代表の秘密鍵をサーバーに置く鍵管理のリスクから見送り。SDK（XDK）が正式版になったら再検討
- そのため DM は2本立てにする
  - ① 旧形式DM: 下記のとおり自動取得 → 分類・返信案 → Slack承認 → API で送信
  - ② 暗号化DM: Slack の「返信アシスタント」（後述）。送信は代表が X アプリから手動で行う
- DM取得: Vercel Cron で5分おきにポーリングで開始（webhook（X Activity API）は後日検討）
  - ポーリングは `max_results` を小さく絞り、取得済みの最新イベント（`settings` に保存したカーソル／`dm_messages.x_event_id`）以降だけを読む。全件の再取得はしない（従量課金対策）
- 新着DMごとに `prompts/dm_classifier.md` で分類し、`prompts/dm_reply.md` で返信案を生成
- Slackに「元メッセージ／分類／返信案」を投稿し、[送信][修正して送信][送らない][リード登録のみ] ボタンを付ける
- `sales_pitch` は返信案なしで通知し、[丁寧に断る（decline_reply を送信）][無視] ボタンを付ける
- `invitation` は `sales_pitch` と同じく [丁寧に断る][無視] ボタンで通知する（招待はすべて断る方針）
- 代表がXアプリから手動で送ったDM（新規フォロワーへの挨拶など）も、DM取得時に `dm_messages`（direction = 'out'）へ取り込む。挨拶ループ防止の判定に使うため
- `reply` が null で `greeting` のスレッドは通知せず close する（ログのみ）
- `spam` は通知せず close する（ログのみ）。`escalate` は返信案なしで通知し、[自分で書いて送信][送らない] ボタンを付ける
- 分類が `inquiry_detailed` / `quote_contract` なら `leads` に自動登録（`escalate` はクレーム等のため対象外）
- 初回のポーリングでは過去のDMを処理しない（最新イベントIDをカーソルとして記録するだけ）
- X の課金は同じリソースを UTC 日内で1回だけ。`x_api_usage` にも重複を除いた額だけを記録する（`x_billed_resources`）
- ② 返信アシスタント: `SLACK_CHANNEL_ID` で `@X Agent` にメンションして DM の本文テキストかスクショを送ると、`prompts/dm_screenshot_reader.md`（スクショのみ）→ `dm_classifier` → `dm_reply` で分類と返信案をスレッドに返す
  - 返信案は装飾なしの独立したメッセージで返す（コピーして X アプリから送るため）
  - 同じスレッドで「もっと短く」などと返信すると、それまでの指示をすべて反映して作り直す
  - リード登録の対象は①と同じ。@ユーザー名が読み取れたら、それで既存リードと名寄せする（無ければ新規）。①で X のユーザー ID が分かったら同じリードに統合する

### Phase 3: 投稿パイプライン
- 毎朝7:45 JST: `prompts/post_writer.md` で3〜5案生成 → `prompts/reviewer.md` で審査 → Slackへ
- 承認時に投稿時刻を選択（デフォルト候補: 7:30 / 12:10 / 20:30）
- Cronで予約時刻に投稿。24h・72h後にメトリクス取得

### Phase 4: 分析
- 毎週月曜8:45 JST: 直近の `post_metrics` から `prompts/analyst.md` でレポート生成 → `insights` に保存しSlackへ
- `post_writer` は最新の `insights` を参照する

### Phase 5: 自動返信の解放
- Slack承認時の「修正率」をカテゴリ別に集計するビューを作る
- 修正率が低いカテゴリから `dm_auto_reply_enabled` を手動でONにする

## コーディング方針
- TypeScript strict。X / Slack / Claude の各クライアントは `lib/` に分離
- LLMの出力はJSONで受け、zodで検証。失敗時はSlackに「要手動対応」で回す
- すべてのエージェント処理は冪等にする（同じDMを二重処理しない）
- 環境変数は `lib/env.ts` のスキーマで管理する。必須の環境変数を追加・変更したときは、`.env.example` を更新し、**Vercel（Production / Preview）への登録と再デプロイが必要なことを必ず利用者に案内する**（Vercel 側の未登録は実行時の 500 でしか分からないため）。突き合わせは名前だけで行い、値は表示しない

## セルフレビュー（報告前に必ず確認）
以降の作業すべてに適用する。報告する前に次の観点を自分で確認し、該当するものは報告に結果を書く。

### 景表法・表現
- 料金に触れる文面には「税抜」「途中解約不可」「プラン期間ごとの自動更新」を必ず含める（言い回しは圧縮してよいが、要素は省かない）
- 開始時期は「最短翌営業日」だけを書かず「通常5営業日ほど」を併記する
- プライバシーマークは「取得申請中」と書き、取得済みと読める表現をしない
- 「必ず」「絶対」「No.1」「最安」などの断定・最上級表現、根拠のない数値を使わない
- FAQ にない料金・条件・実績・取引先名を書かない

### 費用
- X API の呼び出しを追加・変更するときは、1日あたりの概算費用を報告に書く
- URL入りの投稿（1件$0.20）を作らない

### セキュリティ
- APIキー、トークン、secret、DM本文などの秘密情報をチャットに表示しない
- 新しいテーブルには RLS を有効にする

### デプロイ
- 必須の環境変数を追加したら、Vercel への登録手順（Type：Secret / Config、Environments：Production と Preview）と、再デプロイが必要なことを必ず案内する
- Supabase の SQL を追加したら、push より前に実行が必要かを明記する

### 報告の仕方
- 判断が必要なことは「選択肢」と「推奨とその理由」をセットで出す
- こちらで画面操作が必要な作業は、どの画面のどこを押すかまで書く
- SQL や設定ファイルを貼ってもらう必要があるときは、ファイル名ではなく中身をコードブロックで表示する
