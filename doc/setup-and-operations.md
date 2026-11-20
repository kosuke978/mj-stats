# 環境構築と運用

Phase 2.5で追加した専用ローカルDB/Auth/メールと移行・復旧の手順。Step 1では共有DBをREAD ONLYで取得し、実コピーへの増分を隔離検証したうえで、新設の専用QAにStep 1までを適用した。元共有DBは未適用。本番の適用・公開は開発者判断待ち。

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

local:initは既存鍵を保持し、なければGit管理外のsupabase/signing_keys.jsonへES256鍵を作る。CLIが設定済み鍵を先に読むため、初回は空配列を作ってからgen signing-key --appendを内部実行する。鍵をターミナルへ出さない。local:prepareはDockerのproject label・専用ポート・Auth URLとD-41の権限を照合し、専用APIロールのランダムパスワード、.local/api.env・web.env・acceptance.jsonを設定する。Auth所有者の権限は使わない。既存api/.envとweb/.env.localは変更しない。prepareを再実行すると検証用秘密値を更新するため、稼働中のGo/Webは再起動する。

```bash
# 別ターミナルで起動。既存.envより専用環境変数を優先する。
node scripts/run-local.mjs api
node scripts/run-local.mjs web
# ビルド済みWebでの受入を行う場合
node scripts/run-local.mjs web-build
node scripts/run-local.mjs web-start
```

`web`と`web-start`を同じポートで同時起動しない。確認/回復のメールテンプレートはSupabaseのtoken_hashを/auth/confirmへ渡す。Site URL/許可URLをlocalhost:3000に固定し、確認必須・匿名Authなし・8文字以上のパスワード・refresh rotationを有効にする。OTP期限は3600秒、通常セッションに独自のtimebox/inactivity timeoutは設定しない。Mailpitはローカルの捕捉用。管理QAではMailtrap Sandboxへの実SMTP配送と確認/回復を開発者が確認した。実利用者への外部配送は公開前に別途確認する。

### migrationとAuth権限の適用

- 空の専用スタック：CLI start/resetが [migrations](../supabase/migrations) を時刻順に通常postgresとして適用する。マージ後レビュー修正までで17本。D-40の旧 `supabase/permissions/step1_auth.sql` は適用しない。
- baselineは観測済み7表39列20制約9 indexを再現する。既存DBへCREATE TABLEを再実行しない。既存環境の正確な列・制約・index・RLS・policy・triggerを照合した後だけbaselineを履歴へ記録し、増分を適用する。再開後の実コピーで一致と増分保全を確認した。元の共有DBには適用しない。
- `node scripts/test-migrations.mjs` は識別済みコンテナ内の使い捨てDBで、Authメタデータ契約と合成旧データを用意して増分と再適用拒否を確認する。`--snapshot .local/legacy-actual-20261117.json` を指定すると実コピーの構造を照合し、全元列値・参照を比較する。元のスナップショットは `api` で `go run ./cmd/legacy-snapshot ../.local/legacy-actual-20261117.json` によりREAD ONLY取得する。生成した一時DBだけをfinallyで削除する。
- D-41ではpostgres所有の非公開viewを通じて限定7列と行ロックを委譲する。関数所有はNOLOGIN/NOBYPASSRLS、viewのSELECT/UPDATE(id)だけでAuthへの直接権限は持たない。viewへの実UPDATEはtriggerで拒否する。AuthのRLS/policyを変更せず、所有者やsupabase_adminの追加作業を要求しない。
- 通常APIロールにAuth/view直接SELECT/UPDATEや参加者DELETEは与えない。関数のPUBLIC/anon/authenticated/service_role EXECUTEも拒否する。旧方式を適用したローカルは識別を確認してfresh resetする。共有/管理環境のresetへ転用しない。

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

実時間の期限切れ・再送・回復時の障害は、ルートの `npm run test:auth-expiry` で実行する。識別済みローカルだけOTP期限を一時2秒にし、Auth再起動後に登録/回復の期限切れと再送、Authコンテナ停止中の503、復旧後の更新を試す。finallyで元の設定と3600秒のスタックへ戻す。DBデータは保持する。中断時は `.local/expiry-original-config.toml` と設定を照合して通常設定へ戻してから再開する。管理環境へこの故障注入を行わない。

### 専用の管理Supabase QA環境

元の共有プロジェクトへ書き込まず、開発者が用意した **mj-stats-step1-qa** を使う。今回のRefは `ndwjiiqhliwjpsqqoarg`。DB/Authとも新設時の空を読み取り確認した。ローカル識別名mj-stats-step1をremoteへlinkせず、`.local/managed-project` の中だけに関連付ける。

1. `npm run supabase -- login` を開発者が行う。秘密トークンをチャットや文書へ貼らない。
2. `.local/managed-project/supabase` を作り、[QA設定例](../supabase/config.qa.example.toml)を `config.toml` としてコピーする。`supabase/templates` の2ファイルも同じ相対配置でこの専用ディレクトリ内へコピーする。CLIはworkdir外のcontent_pathを拒否する。
3. `npm run supabase -- link ndwjiiqhliwjpsqqoarg --workdir .local/managed-project` を実行する。以後のremoteコマンドもRefを明示し、プレビューのtargetを照合する。
4. `npm run supabase -- db push --remote=ndwjiiqhliwjpsqqoarg --dry-run --skip-vault` で3本だけを確認し、同じ指定で `--dry-run` を外して `--yes` を付ける。空環境向けbaselineであり、既存7表がある環境にこの手順を使わない。
5. QAのDatabase SettingsからSSLのCA証明書をダウンロードし、Git管理外の `.local/supabase-ca.crt` へ置く。verify-fullとsslrootcertで証明書・ホスト名を確認する。[SupabaseのSSL手順](https://supabase.com/docs/guides/platform/ssl-enforcement)を参照する。
6. QAのCustom SMTPを検証専用の配送先へ設定する。新規Freeは標準配送中のメール本文変更ができない（D-42）。[Mailtrap Email Sandbox](https://docs.mailtrap.io/getting-started/email-sandbox)等の受信箱を使い、検証メールを外部利用者へ送らない。SMTP資格情報はDashboardまたはGit管理外の専用ファイルで扱う。
7. `npm run supabase -- config diff --remote=ndwjiiqhliwjpsqqoarg --workdir .local/managed-project` のAuth差分を確認し、同じ対象へ `config push ... --yes` で反映する。独自SMTP設定はQA設定例で宣言せず、上書きしない。CLIのJSON結果に `_tag: Error` があれば、終了コードにかかわらず失敗として扱う。
8. `node scripts/prepare-managed.mjs ndwjiiqhliwjpsqqoarg` は名称/Ref/稼働/履歴を照合し、QAのmjstats_apiだけのパスワードと `.local/managed-{api,web}.env`、managed-acceptance.jsonを設定する。通常Go接続には管理者パスワードを使わない。再実行後はQAのGo/Webを再起動する。

QAのGoは `node scripts/run-managed.mjs api`（localhost:8081）。Webは `node scripts/run-managed.mjs web-build` → `node scripts/run-managed.mjs web-start`（localhost:3001）。公開Auth URLをビルド時に固定するため、QAは `.next-qa`、ローカルは `.next` へ分離する。これはローカルでQAサービスに接続する検証で、本番へのデプロイではない。

`api` の `MJSTATS_MANAGED_INTEGRATION=1 GIN_MODE=release go test -run TestStep1ManagedSupabase -count=1 -v .` で実QAのES256/JWKS、専用APIロール、初回/並行me、名前、公開/直接権限拒否、並行local signOut/Auth削除と元IDの保全を確認する。管理CLIのSQLも専用QAに固定する。負の署名fixture全種と旧対局契約の回帰はローカルの包括試験を使い、管理環境で実施した範囲と混同しない。作成するのはQA用主体と参照だけで、共有のコピーや本人情報をQAへ流用しない。

## Step 2 / 2-1のローカル適用と検証

2-1は [20261118000000_league_membership_foundation.sql](../supabase/migrations/20261118000000_league_membership_foundation.sql) のみを増分追加する。既存3 migrationを変更しない。専用ローカル `mj-stats-step1`（DB 127.0.0.1:55422）と、その中の使い捨て `mjstats_migration_*` DBを使用する。元共有DB・既存QA `mj-stats-step1-qa`（`ndwjiiqhliwjpsqqoarg`）へは適用しない。QAのStep 1証跡を保持し、追加適用と管理環境の総合受入は後続区切り。

```bash
# project_id=mj-stats-step1、コンテナlabel、55422、未linkを確認して実行
# CLI 3.2.0ではmigration upの既定はlocal。--remoteを付けない。
npm run supabase -- migration up
npm run test:migrations
npm run test:migrations -- --snapshot .local/legacy-actual-20261117.json
# apiディレクトリ。専用ローカル接続設定の準備後
MJSTATS_INTEGRATION=1 GIN_MODE=release go test -run TestStep1RealDBAuth -count=1 -v .
```

migration試験は環境を識別してから使い捨てDBを作る。空DB全適用と旧コピー増分の列/制約/index/RLS/policy/triggerを照合し、元列の全値とStep 1追加列を比較する。合成NULL/未知role・Auth解除済みregistered等の移行試験は一時tx内で行いrollbackする。再適用拒否に加え、検証用の `supabase_migrations.schema_migrations` 履歴で欠落/SQL相違/未知版を注入し、次DDLの前の照合で拒否する。これは隔離試験ハーネスの履歴検査であり、管理SupabaseのCLIがSQL改変まで自動検知する保証ではない。実適用前は履歴と実スキーマを別途照合する。

使い捨てDB内で空構築→コピー構築のためpublic/private schemaを再作成し、finallyで当該一時DBだけを削除する。通常のpostgres DB、共有/QAのresetには転用しない。失敗ログはSQLSTATE・検証箇所のみとし、元データ・接続秘密を出さない。

通常リーグは番号必須、旧番号NULLは非掲載・通常APIロールから不可視。所属のkindはusersの値を明示し、通常statusはactive等を明示する。初期owner所属まで同一txで作成する必要があり、リーグだけのcommitは拒否される。owner変更は旧owner降格→新owner設定→owner_id更新を同一txで行う。Goの認可/版照合/同意/記録は後続実装。物理DELETE権限は追加しない。

今回の `local:prepare` 前の `.local/api.env`・`web.env`・`acceptance.json` は `.local/step2-1-original-local-config/` に保存した。Step 1の証跡・スナップショット・署名鍵、既存api/.env・web/.env.localを保持する。管理QA試験のfixtureもkindを明示する形に更新したが、**2-1未適用の既存QAでその試験を再実行しない**。後続の適用承認とmigration後に行う。

戻す必要がある場合も、既存行を削除して再適合させず、書込みを止めて対象・直前版・保存コピーを確認する。今回の適用先は専用ローカルだけ。共有/QAへ逆DDLを適用しない。最新の結果と未実施は[2-1の検証記録](quality-and-acceptance.md#step-2--2-1の検証記録2026-11-18)を参照する。

## Step 2 / 2-2のローカル適用と検証

専用ローカルでは既存4本を確認し、`20261118001000_rule_season_foundation.sql` → `20261118002000_match_attribution.sql` の順に適用する。上記と同じローカル識別チェック、`npm run supabase -- migration up`、合成/保存済み実コピーの `npm run test:migrations`、Goの実Auth回帰を使う。旧コピーの取得済みファイルは読み取り専用で使う。2-1未適用の既存管理QA・元共有DB・本番への適用は後続の承認範囲。

2本目の適用後はNULLの対局日時を読める互換修正入りGoで起動する。旧履歴JSONは既知の記録日時で従来表示を維持し、DBへ日時を書き戻さない。既存のrule_idやcreated_at自体がNULLの行を旧APIで返す契約は今回変えていない。旧書込みはlegacy領域だけに残り、通常対局は後続の対応が揃ってから書き始める。2-3/Step 3の切替順は [設計](architecture.md#step-2--2-2の対局結果の帰属)、検証結果は [品質文書](quality-and-acceptance.md#step-2--2-2の検証記録) を参照する。

## Step 2 / 2-3のローカル切替

1. 専用ローカル `mj-stats-step1`、Docker label、DBポート55422、未link、既存6版を確認する。元共有DB・本番・既存管理QAは適用先に含めない。
2. GoとWebの旧プロセスを止める。旧GoのDB接続が終了したのを確認し、`npm run supabase -- migration up` で `20261118003000_league_history_cutover.sql` を適用する。
3. 2-3対応Goを起動し、リーグ認可、旧履歴のscopeなし400、旧POSTの409、通常INSERTの拒否を確認してから対応Webを起動する。
4. 不具合時は履歴と記録の入口を停止したまま修正する。通常行が読めるpolicyと旧Goの組合せへ戻さず、旧INSERT権限も再付与しない。元の行値を復元する必要はない。別環境で再現する場合は保存済みコピーを専用ローカルの一時DBで使う。

## Step 2 / 2-4のローカル適用

2-3までの既存7版を照合後、専用ローカルだけに `20261118004000_league_creation_events.sql` を適用し、対応Goを起動する。8本の空DB構築、合成/保存済みコピーの `npm run test:migrations`、実Authの `TestStep1RealDBAuth` を使う。既存の管理QA・共有DB・本番への適用は後続判断。今回のGoを使う場合は先に増分を適用する。問題があれば作成入口を停止して対応版を修正し、作成済みリーグやイベントを削除して復旧しない。

## Step 2 / 2-5のローカル適用と招待鍵

`mj-stats-step1` のDocker labelとDBポート55422、未link、2-4までの8版を照合する。`npm run supabase -- migration up` で `20261118005000_league_invites.sql` を適用し、対応Goを起動する。招待は追加の表・イベント権限を使う。問題時は招待入口を停止し、招待・操作記録をDBに保ったまま対応版を修正する。2-3の履歴認可と旧記録停止を維持する。元共有DB・既存管理QA・本番は適用対象外。

- Goの `APP_ORIGIN` はWebのHTTP(S)オリジンを設定する。ローカルの例は `http://localhost:3000`。HTTP Host、転送ヘッダー、本文は生成先に使わない。
- `INVITE_KEYS_JSON` は、キーを正の整数の10進文字列とし、値を32バイト以上のランダム鍵の標準Base64（必要なパディングを含む）とするJSONオブジェクト。`INVITE_CURRENT_KEY_VERSION` は発行に使う版で、JSON内にある正の整数を指定する。両設定が空なら招待管理だけ503。片方だけ設定した場合や形式・オリジンが不正な場合は起動時に一般化した設定エラーを返す。
- 鍵はGoの環境用シークレットに設定する。鍵・発行応答のコードやリンクは共有.env、ログ、操作記録、Postmanの例・共有履歴に残さない。旧鍵がないかhashが一致しない有効招待の再表示は503。
- 鍵切替は、まず現行版を変えず、新版の鍵を全Goプロセスで読めるようにしてから発行版を新版に変更する。旧版で発行した未失効・期限内の招待が全て期限切れか失効になるまで旧鍵を保持する。発行版を戻すときも、その間に発行した新版の鍵を保持する。
- 合成と保存済み実コピーの `npm run test:migrations`、`api` の `MJSTATS_INTEGRATION=1 GIN_MODE=release go test -run TestStep1RealDBAuth -count=1 -v .` で確認する。実Auth試験の招待鍵はプロセス内にだけ生成される。

## Step 2 / 2-6のローカル適用と試行制限

2-5までの9版を照合し、専用ローカルに `20261118006000_league_participation.sql` を適用してから対応Goを起動する。問題時は参加・検索を停止し、既存の所属・参加イベント・招待と2-3の履歴境界を保持する。

- Go専用の `RATE_LIMIT_HASH_KEY` は32バイト以上の乱数を標準Base64で設定し、全インスタンスで共有する。鍵変更はカウントのキーを切り替える。設定が空のままなら検索・招待照合は503とし、各上限も空の場合はGoを起動できる。
- 既定は検索30回/本人/分、照合10回/本人・リーグ/分と60回/接続元/分。`SEARCH_RATE_LIMIT`、`INVITE_LEAGUE_RATE_LIMIT`、`INVITE_IP_RATE_LIMIT` で上書きできる。DBの分単位固定ウィンドウを共有し、超過は429、`Retry-After` は次のウィンドウまでの秒数。照合・再送のカウントは所属の書込みと別に確定し、拒否やrollbackでも残る。
- 既定はTCPの接続元を採用する。`TRUSTED_PROXY_CIDRS` を設定する場合、管理下の経路のCIDRを列挙し、そのプロキシがクライアントからの転送ヘッダーを正規化するように構成する。Goは信頼済み接続元の `X-Forwarded-For` だけを評価する。ブラウザから任意の転送ヘッダーで接続元を変えられないことを公開前に確認する。
- カウンタは接続元や本人・リーグの生値を保持せず、用途を含めてHMAC化する。Go起動時と1分ごとに、ウィンドウ開始から2分を過ぎた行を削除する。Go停止中は削除が保留される。招待コード、平文IP、検索語をカウンタや操作記録・ログへ保存しない。

## Step 2の最終切替と確認

専用ローカルはmigration全10版の履歴を確認し、2-6のGoを起動してから2-7のWebビルドを起動する。2-2以前から適用する場合は、上記の2-3で旧Go/Webを停止した切替を先に行う。招待鍵と試行制限用鍵はGo側だけに設定する。旧Goの全件履歴や旧計算・保存への復旧を行わず、切替障害時は影響する入口を停止して対応版を修正する。既存行と操作記録を保持する。

ブラウザ確認は専用Goと本番モードのWebを起動後、`web` で `npm run test:browser`。参加試験は当該ローカルだけに使い、試験リーグとその所属・招待・対局をfixtureに限定する。既存管理QAは2-1以後の増分が未適用。QAで追加受入を実施する場合は対象Ref、2-1〜2-6の増分、旧プロセス停止、保存コピー・復旧方針、Authと参加/履歴の主要操作を照合して適用承認を得る。

## Step 3の切替と復旧

専用ローカルは `mj-stats-step1`（DB 55422、Auth 55421）。以前の10 migrationを保持し、`20261118007000_guest_participant_links.sql` → `20261118008000_exact_match_recording.sql` の順で追加する。旧numeric、旧IDと参照、帰属不明なlegacyを保全する。元共有DB、既存管理QA、本番への適用はそれぞれ別の承認で扱う。既存管理QAがStep 1のままなら不足するStep 2増分を先に順番どおり適用する。対象Refとmigration履歴は実行の直前に照合する。

1. 対象のデータ・migration履歴・旧結果値を保存し、復元先を隔離して確認する。同じコピーで空DBへの全12本の適用と、10本適用済みの状態からの増分・データ照合を試す。バックフィルは `match_results` を更新するため、対局書込みを止めた時間帯を確保する。
2. Go/Webと対象への書込みを停止し、DB増分を順に適用する。再適用が0件であることと、旧値との分数換算、原ID・参照・帰属、GoのロールとRLSを確認する。
3. Step 3のGoを先に起動し、新APIでゲスト作成・計算・保存・履歴/詳細・同じ操作IDの再送、未所属/別リーグの拒否、旧POSTの410を確認する。続いてStep 3のWebを起動し、分数型に対応する同じ版のGoと組にして公開を再開する。旧履歴アダプタも新しいpoint型を返すため、旧Webと新Goを同時に公開しない。
4. 障害時は入口の対局保存を停止し、必要に応じて管理者が `api_exact_match_create`、`api_exact_result_create`、`api_exact_revision_create` の `WITH CHECK` を `false` に絞る。ゲストや本人紐付けも影響するなら対象の変更入口を停止する。読み取り、分数と作成記録、操作IDを保全し、最後の送信が不明な利用者には復旧後に同じ本文と操作IDで再送してもらう。修正後、migrationと一致する許可条件・受入を照合してから入口を再開する。
5. 正確値で記録を始めると旧numericには表現できない値があり、旧書込みへの切戻しは既存結果と再送を壊す。復旧は正確値を読める版の修正・再配置を基本とする。データ復元が必要なら、停止時点のバックアップと切替後に記録された対局・結果・操作記録を隔離先に復元し、損失範囲を照合して開発者が判断する。

ローカルでの検証は `node scripts/test-migrations.mjs`、保存済みコピーでは `node scripts/test-migrations.mjs --snapshot .local/legacy-actual-20261117.json`。専用ローカルで `MJSTATS_INTEGRATION=1 go -C api test -count=1 -v -run '^TestStep1RealDBAuth$' .` を実行し、本番モードのWebとGoを立ち上げて `cd web && npm run test:browser` を実行する。招待の短時間連続照合を含むブラウザfixtureでは、試験プロセスの上限を広げて実行できる。既定相当の制限および429はGoの招待・参加統合試験で確認する。証跡は [Step 3受入](quality-and-acceptance.md#step-3の受入) を参照する。

## Step 5の切替と復旧

専用ローカルは `mj-stats-step1`（DB 55422、Auth 55421）。作業前に対象のproject label、未link、バックアップ、直前までの12版を確認する。次の4本を古い順に適用する。

1. `20261119000000_match_management.sql` で変更履歴と対局の版遷移制約を追加する。
2. `20261119001000_league_management.sql` で管理監査、owner引継ぎ、本人紐付け解除を追加する。
3. `20261119002000_ranking.sql` でapp結果の分母と順位表の索引を追加する。
4. `20261119003000_rule_recording_lock.sql` でmemberによる新規記録とルール利用停止がロックで順序付くことを維持する。

適用前に書込みを停止する。専用ローカルでは `npm run supabase -- migration up --local` を使い、再実行時の適用0件を確認する。空DBと保存済み実コピーへの順序・値・ID・参照の照合は `node scripts/test-migrations.mjs` と `node scripts/test-migrations.mjs --snapshot .local/legacy-actual-20261117.json` で実施する。本番モードのGoを先に起動し、認可・新規記録・訂正・取消・順位表に続けてWebを確認する。[専用ローカルの起動手順](#step-1の専用ローカル環境)に従い、招待鍵・試行制限鍵はローカル用を設定する。

障害時は管理書込みと影響範囲の対局記録を止める。取消済み対局、理由・前後、操作ID、所属・本人対応を保持し、互換性のある修正版を適用する。DB復元が必要なら直前バックアップと書込み停止までの差分を隔離先へ取り、監査・4結果・分数・owner参照・版・再送を照合する。データの切戻しは照合と開発者判断を経て行う。公開前の実環境受入は[実設定の確認](#実設定の確認と公開前の条件)を参照する。

### マージ後レビュー修正の増分

Step 5までの16本の後に、`20261120000000_retain_match_participant.sql` を適用する。Goを先に切り替えると、脱退・除名済みの原IDを維持する訂正が旧RLSに拒否される。対象と履歴を照合し、書込み停止中にDB→Go→Webの順で切り替える。専用ローカルのQ-25は空DB・合成・保存済み実コピー・隔離復元・再適用0件の手順を使う。元共有DB・管理QA・本番への適用は別途判断する。

PRチェックはGitHub Actionsの `PR checks`。Goは `go test ./...` と `go vet ./...`。Webは `npm ci`、`npm run lint`、`npx next typegen`、`npx tsc --noEmit`、`npm run test:auth`。通常のチェックには専用スタックを起動する必要がない。実Go・DB・Authの受入では上記の専用ローカルを使い、Goにローカルの招待鍵と試行制限鍵を設定する。ブラウザ試験で短時間に繰り返し照合する場合は専用プロセスの上限を上げ、既定の上限と429はGoの統合試験で確認する。

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

[seed.sql](../api/db/seed.sql) はbaselineに旧対局を投入する移行確認用の素材。Step 3のDBに旧形式を投入すると分数の必須制約により拒否される。日常のローカル確認はAuthでログインし、アプリでリーグを作成して対局を記録する。

seedを使う前に、専用DBの実スキーマを確認する。

1. [確認済みスキーマ](architecture.md) と投入先の7テーブル、ID型、FK/UNIQUE、既定値、NULL可否を照合する。今回の接続先の実体は取得済みだが、別環境も同じとは仮定しない。
2. 2026-10-06の調査では実DBとseedのseason IDはUUID、旧APIは整数だった。現在のリーグ別契約ではUUIDまたは未指定を使う。
3. 初回調査では旧19対局中18件の `recorded_by` が未設定だった。現在の保存はGoが認証済みの本人を記録する。旧行の本人は推測で補完しない。
4. `ON CONFLICT` の対象となるPK/UNIQUEがあることを確認する。`users` 等は衝突時に名前を更新するため、無害な読み取り操作ではない。
5. 接続先が開発用であることと影響を確認した上で、SQL Editor等から投入する。

seed単独では新しいDBを構築できない。Step 1のbaseline/認証migrationを先に適用する。再開後の共有実コピーとbaselineの列・制約・index・RLS等の一致は確認済み。古いPostman READMEの「ルール1件だけ作成するSQL」は、leagueや必須項目の制約に適合するか未確認なので、そのまま初期構築手順に使わない。

共有DBの実体記録は過去の観測。Step 1 migrationは専用ローカルだけに適用し、共有には適用していない。また、ルール2件はleague_idがNULLだった。seedは既存ruleの衝突時にnameだけを更新するため、単に再実行しても所属は補完されない。既存の帰属を確認して移行方針を決める。

2026-10-10、開発者が2026-10-06の調査時点の5参加者・19対局を動作確認用テストデータと確認した。実本人への認証紐付けや実運用の成績へ自動転用しない。元DBのデータは現時点で保持し、削除・リセットを行わない。専用開発/検証環境のfixtureと元データの保管・扱いは、下記の設計確認11に従う。テスト用途との回答だけを理由に既存のNULL所属・シーズンを推測で補完しない。

ID対応の目標変更はD-21で承認済み。既存 `users.auth_id` のNULL許容・UNIQUEを維持し、`auth.users.id` への `ON DELETE SET NULL` のFKを追加する設計とする。適用環境、孤立auth_idの確認、権限、適用・戻し方は下記の設計確認11に従う。2026-10-06の観測では全5件がNULLだが、実装時には直前の状態を再確認する。Auth削除による参加者・成績の削除を行わず、本人紐付けは名前一致で自動補完しない。この記載は現在のDBを変更したことや、削除操作を許可したことを意味しない。

## 現在の確認手順

DB接続確認：

```bash
curl -i http://localhost:8080/api/health
```

同じ専用ローカルAuthの本人Bearerを使用する。access tokenのローカル値は履歴やログへ残さない。

1. `/login` → `/` で有効所属を確認し、リーグを選ぶ。安全な復帰先が指定されている場合は、認可付きで目的の画面へ戻る。
2. リーグホームから新規対局入力と `/matches/league/{league_id}` の履歴へ進む。有効なルールと登録者・未紐付けゲストを候補に表示する。履歴ではシーズン・次ページ・詳細を確認し、別リーグの成績が混ざらないことを確認する。
3. 名前設定済み本人の旧計算・保存POSTは410 `API_RETIRED`、`league_id` なしの旧履歴GETは400。2-3時点の409と停止画面は[当時の契約](features-api.md#2-3時点の履歴と停止中の旧経路)を参照する。
4. 運営者の設定更新は `PATCH /api/leagues/{league_id}/settings`。停止したルールは設定で再開できる。シーズンPATCHは省略項目を保持し、明示したnullで日付境界を解除する。使用済み期間は409で保護し、名前の変更はできる。

### Postman

[Postman手順](../api/postman/README.md)からv2.0 collectionとlocal environmentを取り込む。health → me → 名前設定 → My Leagues → 選択したIDで参照・履歴。旧経路の停止と401/403/404も確認できる。

## Step 1以降の運用確認

D-26の自己登録には、SupabaseのEmail確認設定、確認後URL/ローカルと公開環境の許可URL、メール配送の実設定が必要。専用QAの設定とSandboxまでの受信は確認済み。共有/本番の実設定は未確認。[SupabaseのSMTP資料](https://supabase.com/docs/guides/auth/auth-smtp) は標準メール配送を一般公開の本番用途に適さないものとし、プロジェクトチーム外への配送に独自SMTP設定を要求している。項目11で配送サービス・送信元・設定・確認環境を決め、実利用者向け公開前に到達と確認後の導線を検証する。設計中にSMTP契約・設定変更・実メール送信は行わない。

D-30の本人によるパスワード再設定も同じ配送基盤を使い、回復後の許可URLと専用確認環境を整える。アプリ側へSMTP資格情報やパスワードの独自保存を増やさない。登録確認と回復のメール・URLを区別して、期限切れ・再送・更新失敗をQ-21で確認する。専用ローカルと管理QAで確認/回復を受け入れた。実利用者への配送は公開前に別途確認する。

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

Auth主体/セッション検証は公開しないschemaのSECURITY DEFINER関数へ限定する。入力は検証済みsub/session_id、出力は有効性だけ。D-41に従い、関数所有のNOLOGINロールへpostgres所有viewの必要列と行ロック権限だけを与え、Authへの直接権限を与えない。関数は完全修飾したviewを固定SQLで読み、元のAuth行を主体→sessionの順に共有ロックし、時計・メール確認/停止/削除/not_afterを判定する。Auth表の値をアプリ独自に更新しない。

関数作成とPUBLICのEXECUTE剥奪・Goロールへの限定EXECUTEは同一migrationで行い、search_pathは信頼できるschemaと最後のpg_tempに固定する。[PostgreSQLのSECURITY DEFINERの注意事項](https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)を適用する。Goは各要求の署名/claims検証の後に呼び、書込みtx内の共有ロックをcommit/rollbackまで維持する。ロック取得に失敗したら検証を省略せず503にする。

適用環境でAuthの列・RLS・所有者/GRANT・Supabase更新との互換性を確認し、通常ロールで関数実行、Auth表直接更新の拒否、公開ロールの関数実行拒否、並行signOut/主体削除と書込みの順序を試験する。以前のSELECT確認だけをこの試験の代わりにしない。想定の列/ロック動作が成立しない場合はStep 1の受入を止め、検証方式の設計を更新する。

### 実装で追加する設定

| 設定 | 配置・用途 | 確認時期 |
| --- | --- | --- |
| SUPABASE_URL | Go専用の信頼プロジェクトURL。issuerと固定JWKS URLを導く。Webのプロジェクトと一致 | Step 1 |
| ALLOWED_ORIGINS | Goの許可originリスト。ローカルはhttp://localhost:3000。全origin許可で認証を通さない | Step 1 |
| APP_ORIGIN | Web/Goが生成する確認後/招待URLの基準。HTTP Hostやbodyの外部URLを信用しない | Step 1〜2 |
| INVITE_KEYS_JSON、INVITE_CURRENT_KEY_VERSION | Goだけが持つ鍵版と32byte以上のランダムHMAC鍵。期限内招待の旧鍵を保持。Git/ブラウザへ出さない | 2-5実装済み |
| RATE_LIMIT_HASH_KEY | Go専用の32byte以上のランダム鍵。接続元の短期カウンタをhash化。平文IPをアプリ表へ保存しない | Step 2 |
| Email確認・Site URL・許可URL・確認/回復テンプレート | Supabase側。ローカル受信先でtoken_hashのverifyOtpと登録/回復を区別して試験 | Step 1 |
| JWT/セッションの現設定 | ES256と実claims、not_after・時間制限の有無。独自の定期ログアウトは追加しない。設定が設計と違えば受入前に解決する | Step 1 |

招待のGo設定は `api/.env.example` に追加済み。試行制限の設定も `api/.env.example` に追加済み。DB接続情報やHMAC鍵を表示する確認コマンドをPRへ貼らない。鍵取得3秒・DB statement/lock待機5秒を初期の技術タイムアウトとして設計し、計測と故障注入で確認する。JWKS鍵変更時は旧新kidの検証、5分キャッシュと失効、必要な再起動を隔離環境で確認してから実環境へ適用する。

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
