# 環境構築と運用

この手順は現在のリポジトリ構成に基づく。Step 1ブランチに専用ローカルDB/Auth/メールとbaseline・認証migrationを追加した。本番デプロイ設定は未整備で、共有環境へは未適用。共有Supabase接続問題の調査・復旧・再試行は開発者の2026-11-17の追加指示で停止している。

## 必要なもの

- Go：`api/go.mod` の `go 1.26.2` を満たすツールチェーン。
- Node.js：Next.js 16.2.3の要求は `>=20.9.0`。プロジェクトでの厳密なNode/npmバージョン固定ファイルはない。
- npm：`web/package-lock.json` があるため、通常は `npm ci` で依存関係を再現する。
- PostgreSQL/Supabase：7テーブルのスキーマ、接続情報、対象リーグ・ルール・ユーザーが必要。
- Supabase Auth：ローカルは登録画面とMailpit、API試験はAdmin APIで専用アカウントを作る。共有環境のアカウントをテストfixtureへ流用しない。

開発には専用のDBとテストアカウントを使う。現在のAPI起動時にseedやテーブル作成を自動実行する処理はない。

## 環境変数

### API：`api/.env`

| 変数 | 必須/既定値 | 用途 |
| --- | --- | --- |
| `DATABASE_URL` | 必須 | PostgreSQL接続文字列。秘密情報 |
| `PORT` | 省略時8080 | Go APIの待受ポート |
| `SUPABASE_URL` | 必須 | 固定信頼プロジェクト。issuerとJWKSを導く。HTTPS、専用ローカルだけloopback HTTP可 |
| `ALLOWED_ORIGINS` | 必須 | カンマ区切りのWeb origin。ローカルはhttp://localhost:3000。wildcard不可 |

新規構築で `api/.env` がない場合だけ、[.env.example](../api/.env.example) をコピーして編集する。既存の `.env` を上書きしない。

```bash
cd api
test -f .env || cp .env.example .env
```

`go run .` を `api` で実行すると `godotenv.Load()` がそのディレクトリの `.env` を読む。DBに接続できなければ起動時に終了する。例示された接続文字列はプレースホルダーなので、使用するプロジェクトの接続情報を設定する。

GoのDATABASE_URLは専用mjstats_apiを使う。所有者/BYPASSRLSロールを通常実行に使用しない。接続・認証設定エラーの詳細はログへ出さない。

### Web：`web/.env.local`

[web/.env.example](../web/.env.example) を参照する。既存の.env.localを上書きしない。次を設定する。実際のキーをGitへ追加しない。

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
NEXT_PUBLIC_RULE_ID=99999999-9999-9999-9999-999999999999
APP_ORIGIN=http://localhost:3000
AUTH_FLOW_SECRET=REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
```

| 変数 | 用途・注意 |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Go APIのURL。現在はブラウザとNext.jsサーバーの両方が利用する。末尾 `/` なしを基本とする |
| `NEXT_PUBLIC_SUPABASE_URL` | ログインに使うSupabaseプロジェクトURL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公開クライアント用キー。JWT署名用secret・DBパスワード・service roleを入れない |
| `APP_ORIGIN` | サーバー専用の正規Web origin。確認URLと安全なリダイレクト/同一origin検証へ使用 |
| `AUTH_FLOW_SECRET` | サーバーだけに持つ32文字以上のランダム秘密値。10分の回復確認Cookieを署名。公開しない |
| `NEXT_PUBLIC_RULE_ID` | 保存対象の実在するrule UUID。例はseed用ID。Step 2で固定依存を解消する |

`NEXT_PUBLIC_` はブラウザへ公開される値である。DB接続先とAuthのプロジェクトを揃え、別環境のUIDやルールを混ぜない。値を変えたら開発サーバーを再起動する。本番向けの公開変数はビルド時の値にも注意する。

## Step 1の専用ローカル環境

CLIはルートpackage-lock.jsonの **Supabase 3.2.0**、PostgreSQLは **major 17**。受入時はDB 17.12.0.000 / Auth v2.198.0 / Mailpit v1.31.3。識別名は **mj-stats-step1**、Auth/API gateway 127.0.0.1:55421、DB 127.0.0.1:55422、受信箱 127.0.0.1:55424。通常のWeb/APIはlocalhost:3000/8080。共有プロジェクトへlinkしない。

```bash
# リポジトリルート
npm ci
npm run local:init
# CLIのstatus/start出力にはローカル秘密値を含み得る。共有ログへ保存しない。
npm run supabase -- start
npm run local:prepare
```

local:initは既存鍵を保持し、なければGit管理外のsupabase/signing_keys.jsonへES256鍵を作る。CLIが設定済み鍵を先に読むため、初回は空配列を作ってからgen signing-key --appendを内部実行する。鍵をターミナルへ出さない。local:prepareはDockerのproject labelと専用ポート・Auth URLを照合し、Auth所有者の権限SQL、専用APIロールのランダムパスワード、.local/api.env・web.env・acceptance.jsonを設定する。既存api/.envとweb/.env.localは変更しない。prepareを再実行すると検証用秘密値を更新するため、稼働中のGo/Webは再起動する。

```bash
# 別ターミナルで起動。既存.envより専用環境変数を優先する。
node scripts/run-local.mjs api
node scripts/run-local.mjs web
# ビルド済みWebでの受入を行う場合
node scripts/run-local.mjs web-build
node scripts/run-local.mjs web-start
```

`web`と`web-start`を同じポートで同時起動しない。確認/回復のメールテンプレートはSupabaseのtoken_hashを/auth/confirmへ渡す。Site URL/許可URLをlocalhost:3000に固定し、確認必須・匿名Authなし・8文字以上のパスワード・refresh rotationを有効にする。OTP期限は3600秒、通常セッションに独自のtimebox/inactivity timeoutは設定しない。Mailpitは外部配送の代替であり、外部SMTPの到達性は未確認。

### migrationとAuth権限の適用

- 空の専用スタック：CLI start/resetが `20261117000000_baseline.sql` → `20261117001000_auth_profile.sql` を適用する。その後local:prepareで `supabase/permissions/step1_auth.sql` をAuth所有者/管理者として適用する。共有ロールやブラウザに管理者権限を与える手順ではない。
- baselineは観測済み7表39列20制約9 indexを再現する。既存DBへCREATE TABLEを再実行しない。既存環境の正確な構造・制約・RLSを照合した後だけbaselineを履歴へ記録し、増分を適用する。今回は共有DBへ接続問題があり、開発者指示で実コピーの取得・照合・増分受入を停止した。
- `node scripts/test-migrations.mjs` は識別済みコンテナ内の使い捨てDBで、Authメタデータ契約と合成旧データを用意して増分と再適用拒否を確認する。実共有コピーの代用としてPASSへ数えない。生成した一時DBだけをfinallyで削除する。
- Auth表の所有者はsupabase_auth_admin、postgresは通常migration用。ローカルではschema USAGE・UPDATE(id)の再GRANTとAuth policy作成をpostgresだけでは行えなかった。D-40の権限SQLをローカル管理者supabase_adminで適用する。管理環境で同じ限定権限を確保できるかは未確認で、共有適用の前提条件として残る。
- 関数所有はNOLOGIN/NOBYPASSRLSで7列SELECTと共有ロックに必要なidのUPDATEだけ。RLS policyはそのロールだけ、実UPDATEはWITH CHECK(false)で拒否。通常APIロールにAuth直接SELECT/UPDATEや参加者DELETEは与えない。関数のPUBLIC/anon/authenticated EXECUTEも拒否する。

検証用resetは `npm run supabase -- db reset --local --yes`。project_id/コンテナlabel/55422を確認した専用環境だけで行い、直後にlocal:prepareとGo/Web再起動を行う。元の共有5参加者・19対局は変更しない。ローカル停止は `npm run supabase -- stop` でデータを保持する。認証なしの旧APIを公開状態へ戻すことを復旧手段にしない。

### 再実行する検証

```bash
# ルート、専用スタック起動後
npm run test:migrations
# api
 go test ./...
 go vet ./...
 MJSTATS_INTEGRATION=1 GIN_MODE=release go test -run TestStep1RealDBAuth -v .
# web（専用Goとビルド済みWebを起動しておく）
npm run lint
npx tsc --noEmit
npm run build
npm run test:auth
npx playwright install chromium
npm run test:browser
```

Goの通常go testは実環境試験をSKIPする。実環境試験は.localのURLが正確にloopback:55421/55422である場合だけ実行し、実Auth Admin APIでfixtureを作る。Webのブラウザ試験はメール受信箱と実Auth/DBを使用し、確認URL・JWTを出力しない。trace/videoは無効、個人データを含み得る結果はGit管理外の.localに保存する。Chromiumは独立したテスト環境で、Safari/実機の受入の代わりにはしない。

通常の `npm run build` が共有.env.localを読む環境では、今回の検証と同じ設定にするためルートのweb-build helperを使う。今回の実行結果・限定ケース・未実施は [品質文書](quality-and-acceptance.md#step-1実装ブランチの検証記録2026-11-17) を参照する。

## 起動

DBのスキーマと必要データ、環境変数を準備してから、別ターミナルで起動する。

API（リポジトリのルートから）：

```bash
cd api
go mod download
go run .
```

Web（リポジトリのルートから）：

```bash
cd web
npm ci
npm run dev
```

Webは通常 `http://localhost:3000`、APIは通常 `http://localhost:8080`。実際のポートは起動ログを確認する。現在の `/` は初期画面なので、動作確認の入口には `/login` を使う。

## DB準備とseed

[seed.sql](../api/db/seed.sql) は、ユーザー5名、リーグ1件、所属5件、ルール1件、2024年のシーズン1件、サンプル対局と4人分の結果を投入する。現在の入力フォームのメンバーUUIDとrule IDはこのデータを前提にしている。日付・名前はテストデータであり、現在の本番シーズンや本人アカウントではない。

seedを使う前に、専用DBの実スキーマを確認する。

1. [確認済みスキーマ](architecture.md) と投入先の7テーブル、ID型、FK/UNIQUE、既定値、NULL可否を照合する。今回の接続先の実体は取得済みだが、別環境も同じとは仮定しない。
2. 実DBとseedのseason IDはUUID、Go型は整数である。不一致を設計で整理し、Step 2の契約・移行で解消する。
3. recorded_byは実DBでNULL可・既定値なし。seedは設定するがAPIは省略し、既存19対局中18件で未設定。後から本人を推測して補完しない。
4. `ON CONFLICT` の対象となるPK/UNIQUEがあることを確認する。`users` 等は衝突時に名前を更新するため、無害な読み取り操作ではない。
5. 接続先が開発用であることと影響を確認した上で、SQL Editor等から投入する。

seed単独では新しいDBを構築できない。Step 1のbaseline/認証migrationを先に適用する。共有実コピーとの再照合は未実施。古いPostman READMEの「ルール1件だけ作成するSQL」は、leagueや必須項目の制約に適合するか未確認なので、そのまま初期構築手順に使わない。

共有DBの実体記録は過去の観測。Step 1 migrationは専用ローカルだけに適用し、共有には適用していない。また、ルール2件はleague_idがNULLだった。seedは既存ruleの衝突時にnameだけを更新するため、単に再実行しても所属は補完されない。既存の帰属を確認して移行方針を決める。

2026-10-10、開発者が2026-10-06の調査時点の5参加者・19対局を動作確認用テストデータと確認した。実本人への認証紐付けや実運用の成績へ自動転用しない。元DBのデータは現時点で保持し、削除・リセットを行わない。専用開発/検証環境のfixtureと元データの保管・扱いは、下記の設計確認11に従う。テスト用途との回答だけを理由に既存のNULL所属・シーズンを推測で補完しない。

ID対応の目標変更はD-21で承認済み。既存 `users.auth_id` のNULL許容・UNIQUEを維持し、`auth.users.id` への `ON DELETE SET NULL` のFKを追加する設計とする。適用環境、孤立auth_idの確認、権限、適用・戻し方は下記の設計確認11に従う。2026-10-06の観測では全5件がNULLだが、実装時には直前の状態を再確認する。Auth削除による参加者・成績の削除を行わず、本人紐付けは名前一致で自動補完しない。この記載は現在のDBを変更したことや、削除操作を許可したことを意味しない。

## 現在の確認手順

DB接続確認：

```bash
curl -i http://localhost:8080/api/health
```

計算確認（DB書き込みなし）：

```bash
curl -i -X POST http://localhost:8080/api/matches/calculate \
  -H 'Content-Type: application/json' \
  -d '{"players":[{"player_id":"p1","raw_score":40000},{"player_id":"p2","raw_score":30000},{"player_id":"p3","raw_score":20000},{"player_id":"p4","raw_score":10000}]}'
```

Step 1ブランチではBearerなしのこの呼び出しは401となる。正しいJWTと名前設定済みなら200でポイント `50 / 10 / -20 / -40` を返す旧契約を維持する。認証を外して旧手順へ合わせない。

画面と保存の確認は専用DBで次の順に行う。

1. `/login` からテストアカウントでログインし、`/matches` への遷移を確認する。
2. `/matches/new` で異なる登録済みメンバー4名と合計10万点を入力し、計算プレビューを確認する。
3. 保存後、DBの `matches` 1件と `match_results` 4件、履歴表示を確認する。現在はログイン者が選択メンバーや記録者に紐付く保証はない。
4. 入力不足・重複メンバー・不正合計・同点・ゲストでのプレビューと保存拒否を確認する。ゲスト保存拒否は現状の制限であり最終要件ではない。

この確認が成功しても、JWT署名検証、リーグ権限、Go側の合計点検証まで完成したとは判断しない。

### Postman

Importする基本セットは、[API v2.0 collection](../api/postman/export/MJ-Stats%20API%20v2.0.postman_collection.json) と [local environment](../api/postman/export/MJ-Stats.local.postman_environment.json)。health → calculate → create → get matchesを確認できる。

Step 1でcollection/YAMLのURLを `{{base_url}}` へ統一した。旧 [MJ-Stats collection](../api/postman/export/MJ-Stats.postman_collection.json) は `{{base_url}}` を使うが、履歴取得を含まない。Step 1でv2.0 collectionへme/PATCH/401ケースを追加し、全collectionの保護APIへBearerを付けた。

v2.0ではhealth → me → 名前設定 → calculate/create/getの順で確認する。JWTなし・不正JWTの401も含む。Postman UIでの実行自体は今回未実施。access tokenはPostmanのローカル値として保持し、保存・exportする値には含めない。正常リクエストだけでなく、JWTなし・不正署名・期限切れ等を確認する。

## Step 1以降の運用確認

D-26の自己登録には、SupabaseのEmail確認設定、確認後URL/ローカルと公開環境の許可URL、メール配送の実設定が必要。現設定は未確認。[SupabaseのSMTP資料](https://supabase.com/docs/guides/auth/auth-smtp) は標準メール配送を一般公開の本番用途に適さないものとし、プロジェクトチーム外への配送に独自SMTP設定を要求している。項目11で配送サービス・送信元・設定・確認環境を決め、実利用者向け公開前に到達と確認後の導線を検証する。設計中にSMTP契約・設定変更・実メール送信は行わない。

D-30の本人によるパスワード再設定も同じ配送基盤を使い、回復後の許可URLと専用確認環境を整える。アプリ側へSMTP資格情報やパスワードの独自保存を増やさない。登録確認と回復のメール・URLを区別して、期限切れ・再送・更新失敗をQ-21で確認する。現設定・実配送・回復の受入は未確認。

- JWTなしでme・計算・保存・履歴が401、healthが200になることを確認する。
- 正しいJWTでmeを取得し、自分のUIDに対応するDBレコードを確認する。seedの固定UUIDを本人UIDの代用にしない。
- ブラウザとServer Componentの両経路でBearerが渡り、期限切れや更新後も動作することを確認する。
- 同じブラウザの再訪でログイン状態を復元し、毎回のパスワード入力なしに利用できることを確認する。Authのセッション有効期間とCookie保存期間を混同しない。
- 認証変更後のCORSで `Authorization` を許可し、`OPTIONS` preflightを阻害しないことを確認する。
- 未ログイン時のページリダイレクト、セッション更新Cookie、セッション破棄を確認する。
- D-27に従う元画面への復帰と、D-28のlocalログアウトを2ブラウザcontextで確認する。一方のログアウトで他方を終了させず、終了済みの古いJWTもGoで拒否する。

2026-10-10のAuthメタデータ調査で、主体/セッション検証に必要な7列と現ロールのSELECT・authスキーマUSAGEを確認した。詳細とJWT/キャッシュ/並行終了の技術設計は [architecture.md](architecture.md) を参照する。Go用SUPABASE_URL、Auth読取・行ロックの限定関数/権限、適用・戻し方は下記の設計確認11に従う。読取成功だけで、行ロックや本番ロールの権限も確認済みとは扱わない。Auth管理表の資格情報を通常のアプリデータとして取得・ログ出力しない。

各確認の結果・環境・未実施項目をPRに記載する。具体的なJWT検証方式やNext.js Proxyへの移行は、対象PRの設計と設定を確認して実施する。

## 移行・環境・権限の設計：設計確認11

この節は2026-11-17の実装用設計で、環境作成・DDL適用・Auth設定変更を実行済みとは扱わない。設計確認完了後のStep 1から順に準備・検証する。[目標データモデル](architecture.md#設計確認11へ渡す目標データモデル)と[目標API](features-api.md#目標api契約設計確認9)を同じPRで反映する。

### 隔離環境とスキーマの管理

ローカル検証はSupabase CLIでDB/Auth/メール確認用のローカルスタックを分離し、実装PRでCLI版とPostgreSQL major 17を固定する。適用SQLの正本はルートの `supabase/migrations/<時刻>_<目的>.sql`、開発用fixtureはその環境専用にする。これは今後作る配置で、現リポジトリにはまだ存在しない。[Supabaseのローカルマイグレーション資料](https://supabase.com/docs/guides/local-development/database-migrations)に沿い、空環境への全適用と既存コピーへの増分適用を別々にQ-25で確認する。

ローカルAuthもGoの許可algに合わせES256で発行させ、起動後の公開JWKSと実ログインのalg/kid/issuerを照合する。必要な署名鍵は [CLIのgen signing-key](https://supabase.com/docs/reference/cli/introduction#supabase-gen-signing-key) でES256として生成し、ログへ出さずGit管理外のファイルへ保存する。採用CLI版の `auth.signing_keys_path` に設定する方式は [Supabase管理の設定例](https://github.com/supabase/supabase-flutter/blob/main/supabase/config.toml) と照合する。例の鍵・RS256設定は転用しない。HS256の古いfixtureを通すためにGoの許可algを広げず、再現できないCLI版はStep 1の環境受入前に解決する。

最初の移行PRは、観測済みスキーマと適用対象の直前スキーマを再照合してbaselineを作る。既存DBを『適用済み』として記録するだけで実体の差を隠さない。以後、適用済みSQLを書き換えず新しいmigrationで進める。通常Go起動・Web起動・seedでDDLを自動適用しない。検証用AuthユーザーはSDK/Admin APIで作り、Auth表へ直接INSERTして代用しない。

既存の5参加者・19対局は元DBで保持する。既存コピーに新しいkind/帰属の列を加える場合は、未確認参加者をlegacy、帰属不明の対局をlegacy/league_id NULLとして保全する。氏名・同卓者・作成時刻・seedと似たIDだけでAuthやリーグを補完しない。通常APIは有効なリーグに帰属する行だけを返す。将来の明示した帰属確認には、対象ID・根拠・担当・前後差分と戻し方を別に揃える。

開発用の新fixtureは専用スタック内で登録者/ゲスト・2リーグ・ルール・シーズン・正常/不正入力を合成する。Auth UIDと参加者IDを分け、固定seedユーザーを実際の本人へ転用しない。cleanup/resetは検証環境の識別を確認してから行い、現在設定されている共有DBを検証リセットの対象にしない。

### Stepと適用・切替・戻し方

| 段階 | DB/API/Webの適用と確認 | 戻し方・停止条件 |
| --- | --- | --- |
| Step 1 認証 | baseline、auth_id FK、kind/名前設定状態、限定Auth検証関数とロールを用意。APIでJWT検証→me/名前、WebのCookie/確認/回復を適用。Q-06〜Q-10/Q-21 | 不正認証が書込みへ進む、メール確認/期限境界が合わない場合は停止。認証を外す旧版へ公開状態で戻さず、旧コードを使う場合は非公開の隔離環境に限定 |
| Step 2 帰属・参照 | league/所属/ルール版/season UUID・NULL・招待・参照制約を追加。所属限定APIへ最小のWeb呼出しを接続。旧記録要求の扱いはAPI切替節に従い停止可能にする。Q-14/Q-16/Q-17 | 帰属不明の旧行は公開せず保全。所属境界が未完成の旧全件APIへ戻さない。旧DBの変更が必要なら保存済みdumpと増分を照合して隔離復元 |
| Step 3 正確値・保存 | n/d列を追加→旧numeric値を厳密に変換→件数/原ID/値を照合。旧numeric列をNULL可にし、新API/Web/ゲスト/操作IDを同時切替。旧保存APIを停止。Q-03/Q-11〜Q-15/Q-23 | 新しい分数をnumeric(6,1)へ戻して失わない。新形式の書込み開始後は旧書込みコードへの単純revert不可。新書込みを止め、正確値を保つ修正版を適用するか、以後のデータも保持した隔離復旧を行う |
| Step 4 導線 | ホーム/リーグ選択/入力保持/空・失敗・再ログインと対象端末を確認。Q-09/Q-10/Q-19/Q-26 | DBを戻す必要のない画面だけのrevertと、API契約に依存する呼出しの切替を区別する |
| Step 5 管理・順位表 | 変更記録・role/引継ぎ・本人対応の解除・訂正/取消と合計順位表を適用。Q-15/Q-18/Q-20/Q-24 | 取消済み行・旧版・操作記録を削除しない。管理UIを止めてもAPIの認可を緩めない。訂正後の集計を再照合する |

各適用前に対象環境、直前版、バックアップ、変更行の件数と参照、実行担当、停止/復旧方法を記録する。migration履歴と実スキーマの不一致、孤立Auth UID・FK違反・非有限値・分母0・不明なデータ分類があれば自動補完せず停止する。schemaのdropや旧列削除は今回の移行に含めず、互換期間終了後の別変更として判断する。

### Go用DBロールとAuthの限定検証

Go用はテーブル所有者/BYPASSRLSを使わない専用ロール `mjstats_api` とする。必要なアプリ表だけのSELECT/INSERT/限定UPDATEを許可し、履歴・参加者・所属・ルールを物理DELETEする権限は付与しない。RLS有効のアプリ表にはこの専用ロール向けのサービス用policyを明示し、ブラウザのanon/authenticatedへ同じpolicyやGRANTを開かない。これは利用者別RLSの代替ではなく、Goでリーグ認可を実行する境界である。

Auth主体/セッション検証は公開しないschemaのSECURITY DEFINER関数へ限定する。入力は検証済みsub/session_id、出力は有効性だけ。関数所有のNOLOGINロールに必要列と行ロックに必要な権限を限定し、Go用ロールへAuth管理表の広いSELECT/UPDATEを付与しない。関数は完全修飾したAuth表を固定SQLで読み、主体→sessionの順に共有ロックし、時計・メール確認/停止/削除/not_afterを判定する。Auth表の値をアプリ独自に更新しない。

関数作成とPUBLICのEXECUTE剥奪・Goロールへの限定EXECUTEは同一migrationで行い、search_pathは信頼できるschemaと最後のpg_tempに固定する。[PostgreSQLのSECURITY DEFINERの注意事項](https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)を適用する。Goは各要求の署名/claims検証の後に呼び、書込みtx内の共有ロックをcommit/rollbackまで維持する。ロック取得に失敗したら検証を省略せず503にする。

適用環境でAuthの列・RLS・所有者/GRANT・Supabase更新との互換性を確認し、通常ロールで関数実行、Auth表直接更新の拒否、公開ロールの関数実行拒否、並行signOut/主体削除と書込みの順序を試験する。以前のSELECT確認だけをこの試験の代わりにしない。想定の列/ロック動作が成立しない場合はStep 1の受入を止め、検証方式の設計を更新する。

### 実装で追加する設定

| 設定 | 配置・用途 | 確認時期 |
| --- | --- | --- |
| SUPABASE_URL | Go専用の信頼プロジェクトURL。issuerと固定JWKS URLを導く。Webのプロジェクトと一致 | Step 1 |
| ALLOWED_ORIGINS | Goの許可originリスト。ローカルはhttp://localhost:3000。全origin許可で認証を通さない | Step 1 |
| APP_ORIGIN | Web/Goが生成する確認後/招待URLの基準。HTTP Hostやbodyの外部URLを信用しない | Step 1〜2 |
| INVITE_KEYS_JSON、INVITE_CURRENT_KEY_VERSION | Goだけが持つ鍵版と32byte以上のランダムHMAC鍵。期限内招待の旧鍵を保持。Git/ブラウザへ出さない | Step 2 |
| RATE_LIMIT_HASH_KEY | Go専用の32byte以上のランダム鍵。接続元の短期カウンタをhash化。平文IPをアプリ表へ保存しない | Step 2 |
| Email確認・Site URL・許可URL・確認/回復テンプレート | Supabase側。ローカル受信先でtoken_hashのverifyOtpと登録/回復を区別して試験 | Step 1 |
| JWT/セッションの現設定 | ES256と実claims、not_after・時間制限の有無。独自の定期ログアウトは追加しない。設定が設計と違えば受入前に解決する | Step 1 |

上記は目標の設定名で、現在の.env/exampleが対応済みとは扱わない。実装PRでexampleに秘密でないplaceholderと用途を加える。DB接続情報やHMAC鍵を表示する確認コマンドをPRへ貼らない。鍵取得3秒・DB statement/lock待機5秒を初期の技術タイムアウトとして設計し、計測と故障注入で確認する。JWKS鍵変更時は旧新kidの検証、5分キャッシュと失効、必要な再起動を隔離環境で確認してから実環境へ適用する。

### 実設定の確認と公開前の条件

設計で決める責務と、実行して初めて確認できる設定・受入結果を分ける。SMTP契約/送信元/実配送、公開URL/ホスティング、実利用人数/SLO、バックアップ/保持・復旧担当と許容停止/損失は公開前に開発者が確定する。未確認の間は『本番運用可』と判断せず、隔離環境でのみ受入を進める。これらはコーディング前の業務仕様の回答待ちとして残すものではない。

実利用者の公開前には、設定した配送先で登録/回復メールが届くこと、非所属・不正JWTの拒否、正確値と再送/取消、backupからの隔離復元と主要操作、秘密値のログ除去を確認し、担当/実測と停止条件をPR/リリース記録へ残す。Auth削除でownerが操作不能になった場合は、本人/現運営と根拠を確認して開発者が復旧の対象・変更前後・承認・戻し方を記録してから対応する。名前一致による自動再紐付け・自動owner昇格は行わない。

## DB・リリース・障害対応

スキーマ変更は、コードのPRと同時に、対象DB、適用SQL、適用順序、既存データへの影響、検証方法、戻し方を記録する。列削除・型変更・過去ルール更新・ゲスト統合は履歴へ影響するため、復旧方法を具体化する。seedをマイグレーション代わりにしない。

2026-11-16のD-06/D-07/D-16/D-17から、項目11へ次の移行条件を引き継ぐ。以下は未適用の設計条件であり、既存DB・seedを書き換える手順ではない。

| 対象 | 適用前に具体化・検証すること |
| --- | --- |
| ルールの版 | 使用済み条件の更新/削除を防ぎ、新しいrule IDを旧対局へ自動付替えしない。計算方式の版、初回保存と編集の並行処理、Go以外の書込み経路をQ-16で確認する |
| 正確なポイント | 現numeric(6,1)とfloat64を正確値の保存モデルへ移す案。旧値は保存済みの10進値を分数へ写し、未確認の旧計算根拠を新版として扱わない。新旧列/API/Webの適用順、旧クライアントの書込み停止と戻し方を揃える |
| 対局日時 | match_date追加案では旧日時不明をNULLとして保ち、created_atを実日時として一律補完しない。GoはUTCを返し、画面は日本時間で対局/記録日時の意味を示す。Q-22の境界例で確認する |
| シーズン未指定 | UUID/NULLをGo/DB/APIで統一し、新規の未指定を許可する。未指定でも対象リーグを特定できる列/参照が必要。既存18対局を推測で割り当てず、帰属不明の既存ruleの扱いは別に解決する |

シーズンを切り替える際に過去対局を削除しない。D-14の訂正/取消、D-15の本人対応と解除、D-08の権限表をGoと変更記録で実現する。通常の操作を無記録の直接SQL変更で代用しない。締め/精算の固有運用はPhase 5で判断する。

現時点では本番環境、ホスティング先、デプロイ手順、バックアップ/復元手順、監視・SLOを確認できる設定がない。`main` の更新が本番へ自動反映されるとは判断しない。リリース作業が依頼された際は実環境を確認し、API/Web/DBの適用順、復旧可能性、healthと主要操作の確認を具体化してから実施する。PRのマージ承認を本番DBの変更承認として流用しない。

### 環境と担当の記録

本番運用を始める前に、確認した実情報で次を埋める。現在の不明な項目を予定の値で埋めて稼働済みにしない。

| 項目 | ローカルの現状 | 検証・本番で確認する情報 |
| --- | --- | --- |
| Web/API | 通常localhost:3000/8080の別プロセス | 配置先、URL、ビルド/起動手順、対象コミット |
| DB/Auth | 再開後に接続確認済み。PostgreSQL 17.6、7テーブルの実体を記録。公開JWKSはES256、2026-10-06に開発者がCurrent keyのECC (P-256)を確認 | 開発/本番の用途と環境分離、接続権限、スキーマ版。接続先の秘密値は文書に保存しない |
| 運用担当 | 当面の作業判断・承認は開発者 | デプロイ、DB適用、障害判断、復元の実行者と確認者 |
| バックアップ | 実設定・復元可能性は未確認 | 対象、頻度、保持、復元手順、直近の復元確認、許容データ損失 |
| 監視・ログ | ローカルの起動/リクエストログ | health、保存失敗、認証基盤の障害を確認する場所。ログの秘匿・保持 |

所属者限定の閲覧と所属登録者の代理記録はD-11/D-12で承認済み。複数リーグの実データ運用前に、非所属者が取得・保存できないことをQ-14/Q-17で確認する。JWT署名検証やhealthの成功だけでは、この運用条件を満たさない。

### リリース・DB変更・復旧の記録様式

```text
対象環境・担当・承認範囲:
対象コミット/PR・関連要求・変更するAPI/スキーマ:
適用前提: 現在のスキーマ版、互換性、設定、必要なバックアップ
適用順: DB/API/Webの順序と、旧版との同時稼働が可能か
実行手順: 環境を指定したコマンド・SQL・操作と所要時間
確認: health、認証、リーグ境界、保存/履歴、対象Qケース
停止・復旧の判断: どの結果なら止めるか、誰が判断するか
戻し方: 前のコードへの切替、DB互換性、必要なら復元手順
結果・証拠: 実施日時、観察値、未実施項目、秘密値を除いたログ
```

列追加と列削除、データ移行では安全な適用順が異なる。DBを常に先に適用する等の固定ルールを作らず、対象変更で決める。コードのrevertだけでDBや失われた履歴が戻るとは扱わない。復元手順は文章があるだけで完成とせず、隔離した環境で復元と主要操作を確認する。

| 症状 | 最初に確認すること |
| --- | --- |
| APIが起動しない | `api` で起動したか、`DATABASE_URL`、接続先・接続権限、起動ログ。接続文字列を共有ログへ貼らない |
| poolerがtenant/user not foundを返す | Supabaseの現在のプロジェクト状態とConnectの接続文字列を照合する。設計確認1ではPaused時に発生し、再開後に読み取り接続が成功した |
| Auth URLが名前解決できない | 現在のProject URLとプロジェクト状態を照合する。設計確認1では再開後に名前解決・公開JWKS取得が成功した |
| healthが500 | 起動後のDB接続障害。ネットワーク・DB稼働・接続情報の変更を確認 |
| `/login` が失敗する | Web側のSupabase URL/公開キー、テストアカウント、Authの設定 |
| 保存が500 | UUIDの存在、season型、FK/NOT NULL、記録者の必須制約。APIログと実スキーマを照合 |
| ログインしても保護APIが401 | ブラウザとServer ComponentのBearer転送、expiry、issuer/audience、鍵方式・鍵更新を確認 |
| ブラウザだけAPIに接続できない | API URL、CORS origin・Authorization header・preflightを確認 |
| 役満/トビが表示されない | 書き込み経路が現在未実装。履歴のfalseフォールバックもあるため表示だけで保存を判断しない |

署名設定の再確認は [JWT設定画面](https://supabase.com/dashboard/project/_/settings/jwt) から対象プロジェクトを選び、『JWT Signing Keys』の『Current key』で方式名を確認する。2026-10-06の開発者の回答はECC (P-256)。公開JWKSの鍵は待機中の場合もあるため、発行用キーの確認と区別する。これは設定を読む手順であり、Rotate/Migrate/Revoke等の変更操作を含まない。

障害時は、発生時刻、対象環境、操作、ステータス、影響範囲を残す。秘密情報を除いたログで原因を調べ、過去データを失わない修正を行う。認証を外すことや整合性検証を省略することを復旧方法にしない。
