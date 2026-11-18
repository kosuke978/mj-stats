# 実装済み機能とAPI契約

前半は現行実装、後半はPhase 2.5全体の目標。Step 1は完了承認済み、2-1はPR #9でマージ済み。2-2でルール・シーズン・対局帰属のDB基盤を追加した。旧保存のbody、数値point、固定ルール計算を維持する。旧履歴はlegacy行を返し、`match_date`がNULLなら`created_at`を旧JSONの`match_date`に使う。DBの実対局日時はNULLのまま。アプリ起源の対局は旧履歴から隔離し、2-3でリーグ認可付き履歴へ切り替える。検証は [品質文書](quality-and-acceptance.md)、工程は [ロードマップ](product-roadmap.md) を参照する。

## 画面と利用フロー

| URL | 実装されていること | 制限・未完了 |
| --- | --- | --- |
| `/login`、`/signup` | Supabaseのログイン・自己登録・確認待ち・再送。安全なreturnToと初回名前設定へ接続 | メールの実外部配送と共有環境での受入は未実施 |
| `/auth/confirm`、`/auth/error` | email/recoveryのtoken_hashをverifyOtpで検証、更新Cookieを保持して303、失敗から再依頼 | 確認URLはログに出さない。通常のメールリンクに加えPKCEのhashも扱う |
| `/password/reset`、`/password/update` | 回復依頼・確認後の本人による新パスワード設定 | 回復確認に紐付く短期の署名Cookieを要求。資格情報はSupabaseへ |
| `/profile/setup`、`/account` | 初回表示名・本人の名前変更・localログアウト、共通本人状態 | 初回未設定は通常画面へ進めず、Goでも403 |
| `/matches/new` | 4人の選択・持ち点入力、ポイント計算プレビュー、保存、履歴へのリンク | メンバー5名が固定。ゲスト保存不可。rule IDは環境変数、seasonはnull |
| `/matches` | Server Componentで履歴を取得、カード表示、入力画面へのリンク、空状態、読み込みスケルトン | 本人のBearerでGoを呼ぶ。全件取得。リーグ・シーズン絞り込みとページングなし |
| `/` | create-next-appの初期画面 | プロダクトのホーム未実装。共通のBottom Navigationなし |

`web/src/proxy.ts` が検証・必要なセッション更新とCookie転送を担当する。保護ページは `/matches` 配下・`/profile/setup`・`/account`・`/password/update`。Server Componentでも本人を確認し、Goが各要求のJWT/主体/セッションを独立に検証する。共通Providerは表示用であり認可の根拠ではない。

### 現行の画面状態と次にできる操作

実装の状態を記す。どの操作を実行したかは品質文書へ分ける。画面を変更する際は「正常表示」だけでなく、操作中・空・失敗・復帰を比較する。

| 画面・状態 | 現在の表示・処理 | 次の操作・遷移 | 制限 |
| --- | --- | --- | --- |
| ログイン・初期 | メールとパスワードの入力 | 送信、登録、再設定へ | セッション有効なら入力を省略 |
| ログイン・送信中 | ボタンを無効化し処理中表示 | 応答を待つ | 成功後の保護画面でGoのmeを取得 |
| ログイン・失敗 | エラーを表示し送信可能に戻す | 入力を修正して再送 | メール確認待ち・入力失敗・通信障害を区別 |
| ログイン・成功 | 安全な元画面へ移動 | 未設定なら名前設定を優先 | 戻り先なしは `/matches`。リーグ認可はStep 2 |
| 履歴・読込み中 | loading.tsxのスケルトン | 応答を待つ | 本人のBearer付きSSR |
| 履歴・0件 | 履歴なしのメッセージ、結果入力リンク | `/matches/new` へ | 所属リーグ別の空状態は未実装 |
| 履歴・取得成功 | 対局カード一覧 | 結果入力へ | 全件。絞り込み・ページングなし |
| 履歴・取得失敗 | 認証失敗は再更新/再ログイン、内部障害はエラー状態 | 再試行する | 失敗を空一覧に変換しない |
| 入力・不備 | 項目エラー、合計の不足/超過 | 内容を修正しプレビューまたは直接保存 | 正常な入力なら計算へ進む |
| 入力・計算中 | ボタン無効化と処理中表示 | 応答を待つ | 計算APIに本人Bearerを付与 |
| 入力・計算失敗 | APIエラーをフォーム側に表示 | 入力を保ち再試行 | 共通エラーのmessageを表示し入力を保持 |
| プレビュー・成功 | 順位・ポイントのモーダル | 戻る、または保存 | 保存時のGo再計算なし |
| 保存・ゲストを含む | 保存未対応のエラー | 登録者に替える、または入力へ戻る | 保存APIを呼ばない。最終要件としては未達 |
| 保存・処理中 | 保存ボタンを無効化し処理中表示 | 応答を待つ | 二重送信のAPI上の保証はない |
| 保存・成功 | モーダルを閉じ、履歴へ移動・refresh | 履歴で結果を確認する | 記録者と所属の検証・保存が未完了 |
| 保存・失敗 | エラーをフォーム側に表示し、入力・プレビューを残す | 内容を確認して再試行できる | 通信失敗時に保存済みかを判別する仕組みは未整備。D-13で再送方針を決める |

ブラウザの「戻る」や再読込で未保存の入力を復元することを保証する、下書き保存処理は実装していない。画面内の状態保持と、ページを離れた後の永続的な下書き保存を区別する。下書き機能を必須スコープへ追加する場合は別途判断する。

### 対局入力の詳細

根拠：[MatchInputForm.tsx](../web/src/components/match/MatchInputForm.tsx)。

- 登録メンバーの選択肢はseedと同じUUIDの5名。同一登録メンバーの重複選択を拒否する。
- 1人目に「起家」と表示するが、座順をAPI・DBへ保存する実装はない。
- 入力欄は100点単位の省略入力。`250` と入力すると内部の `raw_score` は25,000点になる。負点は入力できる。端数入力は `Math.trunc` で整数化して100倍する。
- Zodで4人、選択必須、ゲスト名必須、持ち点入力必須・整数・1人あたり10万点以下を検証する。ゲスト名は前後空白を除去する。
- 合計点・不足/超過を表示し、10万点と一致しない場合はAPI計算に進まない。
- 「計算結果をプレビュー」は計算APIを呼び、順位順のモーダルを開く。「この内容で保存」はモーダル経由の保存と、計算して直接保存する導線がある。
- 保存・計算中はボタンを無効化し、失敗時はエラーを表示する。保存成功後は `/matches` に遷移してrefreshする。
- ゲストは計算のたびにブラウザで一時UUIDを作る。名前は画面内だけで扱い、計算APIへはIDと点数を送る。ゲストを含む保存は画面で明示的に拒否する。
- 計算・保存は共通clientAPIから本人のaccess tokenをBearerで渡す。ログインUIDを固定候補や記録者へ紐付ける処理は後続Step。

## ポイント計算の現在の仕様

根拠：[calculateResults](../api/controllers/match_controller.go)。DBの `rules` は参照せず、25,000点持ち・30,000点返し・ウマ `+20/+10/-10/-20`・総オカ20ポイント相当をハードコードしている。「Mリーグ公式規則を完全に実装した」という意味ではない。

```text
基礎ポイント = (raw_score - 30,000) / 1,000
最終ポイント = 基礎ポイント + 適用順位のウマ + トップへのオカ
```

1. 素点の降順に安定ソートする。
2. 同点者は同順位とし、次の順位を人数分飛ばす。例：1位、1位、3位、4位。
3. 同点者が占める順位のウマを平均する。トップ同点なら20ポイントのオカも等分する。
4. 各ポイントを `math.Round` で小数第1位へ丸める。
5. 丸め後のポイント合計が0でなければ、素点順の先頭の1人から差分を引く。同点トップでは入力順の先頭が対象となる。
6. レスポンスは入力順に戻す。画面はプレビューで順位順へ並べ替える。

| 素点（入力順） | 順位 | 最終ポイント | 説明 |
| --- | --- | --- | --- |
| 40,000 / 30,000 / 20,000 / 10,000 | 1 / 2 / 3 / 4 | +50.0 / +10.0 / -20.0 / -40.0 | seedにも使われる通常例 |
| 35,000 / 35,000 / 20,000 / 10,000 | 1 / 1 / 3 / 4 | +30.0 / +30.0 / -20.0 / -40.0 | 上位ウマ平均15、トップオカ各10 |
| 33,300 / 33,300 / 33,300 / 100 | 1 / 1 / 1 / 4 | +16.7 / +16.6 / +16.6 / -49.9 | 3人同点。入力順の先頭トップが丸め差分+0.1を受ける |
| 25,000 / 25,000 / 25,000 / 25,000 | 1 / 1 / 1 / 1 | 0.0 / 0.0 / 0.0 / 0.0 | 全員同点 |

**重要な制限：** Goは合計点を検証しない。手順5は丸め誤差に限らず、不正な素点合計による差分も先頭へ押し込めてしまう。合計ポイントが0になったことは入力の正しさの証明ではない。保存APIもこの計算処理を呼ばない。

例えば40,000 / 30,000 / 20,000 / 0点（合計90,000点）でも、現行の計算処理は+60 / +10 / −20 / −50ptへ補正して合計0にする。これはコードと数値の静的な検算による説明であり、APIの受入試験結果ではない。目標の入力拒否・端数規則は [設計確認5](architecture.md#設計確認5ルールポイントの設計案)、D-07、Q-11で扱う。

2026-11-16のD-06/D-07では使用済みルールの版管理、100点単位・負点可、同順位・ウマ平均・トップオカ等分を承認済み。開発者の指摘により、小数第1位への四捨五入を目標仕様の前提にはしない。目標は各rule IDの条件から計算した正確値を保全することで、上記の固定計算・丸め・入力順補正は現行負債の説明として残す。分数による正確値の技術案は [同点計算と保存精度](architecture.md#同点計算と保存精度) を参照する。

## API一覧

現在のローカル既定値は `http://localhost:8080`。設定手順は [setup-and-operations.md](setup-and-operations.md)。

| Method / Path | 現在の条件 | 成功 |
| --- | --- | --- |
| `GET /api/health` | 公開、DB疎通 | 200 |
| `GET /api/users/me` | 検証済みJWT＋有効なAuth主体/セッション | 200 |
| `PATCH /api/users/me` | 同上。bodyは `{name}` のみ | 200 |
| `POST /api/matches/calculate` | 上記＋本人の名前設定完了 | 200 |
| `POST /api/matches` | 上記＋本人の名前設定完了 | 201 |
| `GET /api/matches` | 上記＋本人の名前設定完了 | 200 |

全APIの失敗は後半の共通JSON契約を使う。未認証401、参加者未作成403 PROFILE_REQUIRED、名前未設定403 PROFILE_INCOMPLETE、入力400、media type 415、64KiB超過413、鍵/DB障害503。レスポンスとログにSQL・JWT・接続情報を含めない。CORSは指定originとAuthorization/Content-Type、OPTIONSは認証前。本人応答はprivate, no-store。

### `GET /api/health`

DBの5秒以内のPingが成功すると次を返す。失敗は503 TEMPORARILY_UNAVAILABLE。起動時の接続障害は起動を停止する。スキーマ・リーグ認可まで保証するAPIではない。

```json
{"status":"ok","message":"MJ-Stats API & DB are running successfully"}
```

### `GET /api/users/me` / `PATCH /api/users/me`

固定したSUPABASE_URLのES256/JWKSとclaimsを検証し、限定関数でAuth主体・session_idを確認してから、users.auth_idで取得する。GETだけが初回作成を行い、DBが別の参加者UUIDを生成する。初期名はメールを含まないPlayer、名前設定状態はNULL。並行作成はUNIQUE＋ON CONFLICT DO NOTHING＋再取得で同じ参加者へ収束し、既存名を上書きしない。

```json
{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"Player","profile_completed_at":null}
```

PATCHは `{ "name": "表示名" }` のみを受け、Unicodeコードポイント1〜30、White_Spaceによる前後除去、Cc/改行/行・段落区切りの事前拒否をGo/Webで共通化する。同名可。他人のid等は400。初回だけprofile_completed_atを名前と同時に設定し、再変更でその時刻・ID・所属・履歴参照を変えない。書込みはtx内でAuth主体→セッションの共有ロックを取得し、期限も書込み/commit前に再確認する。Auth削除はauth_idだけSET NULLとし、古いJWTでの再作成を拒否する。

### `POST /api/matches/calculate`

リクエスト：

```json
{
  "players": [
    {"player_id":"p1","raw_score":40000},
    {"player_id":"p2","raw_score":30000},
    {"player_id":"p3","raw_score":20000},
    {"player_id":"p4","raw_score":10000}
  ]
}
```

レスポンスは配列で、`matches` 等の外側のオブジェクトはない。

```json
[
  {"player_id":"p1","raw_score":40000,"point":50.0,"rank":1},
  {"player_id":"p2","raw_score":30000,"point":10.0,"rank":2},
  {"player_id":"p3","raw_score":20000,"point":-20.0,"rank":3},
  {"player_id":"p4","raw_score":10000,"point":-40.0,"rank":4}
]
```

Goのbindingと追加チェックで、4人・非空のID・ID重複なしを検証し、違反は400。現在は計算IDのUUID形式・DB存在・持ち点合計・点数単位/範囲を検証しない。`raw_score` はintで、未指定でも0になる。DB書き込みはない。任意IDを使うこの例は現行契約であり、将来の所属・ルール対応時に見直す。

### `POST /api/matches`

リクエスト例。保存するには、対象DBに対応するユーザーとルールが存在する必要がある。

```json
{
  "rule_id":"99999999-9999-9999-9999-999999999999",
  "season_id":null,
  "results":[
    {"player_id":"11111111-1111-1111-1111-111111111111","raw_score":40000,"point":50.0,"rank":1,"is_yakuman":false},
    {"player_id":"22222222-2222-2222-2222-222222222222","raw_score":30000,"point":10.0,"rank":2,"is_yakuman":false},
    {"player_id":"33333333-3333-3333-3333-333333333333","raw_score":20000,"point":-20.0,"rank":3,"is_yakuman":false},
    {"player_id":"44444444-4444-4444-4444-444444444444","raw_score":10000,"point":-40.0,"rank":4,"is_yakuman":false}
  ]
}
```

成功時は201：

```json
{"match_id":"cccc0000-cccc-0000-cccc-000000000000"}
```

IDは形式例。実際にはDBが返した新しいIDを返す。

- bindingで `rule_id` のUUID、4件、非空の `player_id`、rankの1〜4を確認する。参加者ID重複も400にする。
- `season_id` はGoでnullableな整数（`*int`）。実DBとseedはUUIDであり、不一致を確認済み。UUIDをこのbodyへ送るとbinding段階で拒否される。現在のフォームはnullを送るため問題が表面化しにくい。
- トランザクションで `matches` 1件、`match_results` 4件を作り、途中失敗ならrollbackする。DB接続・制約・commitの失敗は503。旧保存契約の参照整合検証はStep 2〜3で整備し、現時点のFK失敗は共通の内部障害として扱う。
- `point` は `final_point` へ、`raw_score` と `rank` はそのまま保存する。Goでルール取得・再計算はしない。素点・pointは未指定だと0になる。
- `is_yakuman` は型として受け取るがINSERTに使用しない。guest名・トビ・座順・対局日時を保存する入力契約はない。
- `matches.recorded_by` を設定しない。確認した実DBはこの列がnullableで既定値なしなので、省略によるNOT NULL違反はないが記録者を失う。実データでも19対局中18件が未設定だった。

### `GET /api/matches`

`matches` と結果・ユーザーをLEFT JOINし、対局日時降順、作成日時降順、結果rank昇順で返す。結果のない対局も `results: []` で含み得る。空一覧は `{"matches":[]}`。

```json
{
  "matches":[
    {
      "id":"cccc0000-cccc-0000-cccc-000000000000",
      "match_date":"2026-10-06T10:00:00Z",
      "rule_id":"99999999-9999-9999-9999-999999999999",
      "created_at":"2026-10-06T10:00:00Z",
      "results":[
        {"user_id":"こうすけ","guest_name":null,"score":40000,"point":50.0,"is_yakuman":false,"is_tobi":false}
      ]
    }
  ]
}
```

結果配列は1人分に省略した構造例。**現在の `user_id` はUUIDではなく `users.name`。** SQLが `u.name AS user_id` を選び、画面もこの値を名前として表示する。相性分析や権限のキーには使えない。将来はIDと名前を分け、Go/Web/Postmanを同時に更新する。

- `information_schema` で列の存在を毎回調べる。`matches.match_date` がなければ `created_at` を日時として使う。
- `match_results.guest_name`, `is_yakuman`, `is_tobi` がなければ、null / false / falseへフォールバックする。列がある場合もDB値がnullならboolはfalseとして扱う。
- 今回確認したDBにはmatch_date・guest_name・is_yakuman・is_tobiの列がない。この環境の日時はcreated_at、ゲスト名はnull、役満・トビはfalseとなる。
- guest/役満/トビの列確認エラーは無視されるため、falseの応答だけで記録が存在しないと判断できない。
- 返却型に `rank` と `season_id` はない。画面はrankではなくpoint降順で並べ、小数1桁・正負の色、役満/トビバッジを表示する。
- 日時は `date-fns` で `yyyy/MM/dd HH:mm` 表示するが、表示タイムゾーンを明示的に固定する処理はない。
- リーグ・所属・公開範囲による制限がなく全件を取得する。SQL・scan・読取り失敗は500。

## 既知の負債と対応時期

| ID | 事実・影響 | 対応する工程 |
| --- | --- | --- |
| T-01 | Step 1でES256/JWKS・claims・Auth主体/セッション検証を実装 | ローカル受入実施。共有環境は未適用 |
| T-02 | Step 1で4 APIを共通認証で保護、ブラウザ/SSRのBearer転送を接続 | リーグ所属認可はStep 2 |
| T-03 | 共通本人Providerと名前設定を実装。対局の固定参加者・記録者は旧契約のまま | Step 2〜3でデータ接続 |
| T-04 | メンバー固定、rule ID固定、計算ルール固定 | Step 2〜3 |
| T-05 | 合計点未検証、順位/pointを信用して保存、計算の補正で不正入力を隠す | Step 2でルール基準を確定、Step 3までに保存時検証を完成。先行修正する場合は範囲を承認する |
| T-06 | ゲストは一時UUIDのみで永続化・保存不可 | Step 3 |
| T-07 | 履歴のuser_idが名前。IDを失い、同名や改名を正しく扱えない | Step 2〜3の契約整理 |
| T-08 | season IDがGoでは整数、実DBとseedではUUID。baselineとStep 1 migrationは追加済み、season型は未変更 | 設計確認で型・NULL方針を確定し、Step 2で契約・移行を実装 |
| T-09 | 記録者未保存、リーグ/シーズン/ルールの整合・所属・権限チェックなし | Step 1で認証主体、Step 2で所属者の閲覧・記録境界と記録者、Step 5で管理権限を具体化。D-11/D-12は承認済み |
| T-10 | 役満入力を保存せず、トビ記録経路もない。表示だけが先行 | Phase 3。先行整備は対象Stepの承認範囲で判断 |
| T-11 | ホーム初期画面、主要ナビなし。全件履歴。認証関連の再試行画面だけ実装 | Step 4。履歴取得方式はデータ量に合わせて見直す |
| T-12 | `proxy.ts`へ移行し通常/redirect応答へ更新Cookieを転送 | Step 1、実行範囲は品質文書 |
| T-13 | Goの単体/実DB・Auth試験、Webの単体/Chromium試験と共通エラーを追加。CIは未整備 | 後続の変更ごとに検証を追加 |
| T-14 | auth_idから別の永続参加者IDを取得する実装へ変更。旧参加者はlegacyとして保持 | 共有実コピーの移行確認は開発者指示で停止中 |
| T-15 | 専用mjstats_api（NOBYPASSRLS）と限定policyを追加。旧共有DBは観測時の状態のまま | Step 2でGoのリーグ認可を追加。Auth管理者の権限設定は環境手順参照 |
| T-16 | ルール2件のleague_idがNULLで、対局の所属をrule経由で追えない。18対局のseason/記録者もNULL | 項目4〜7と移行設計で帰属・既存NULLの扱いを確定。推測で補完しない |
| T-17 | Goのfloat64/math.Round・入力順補正とDBのnumeric(6,1)では、3人同点等の正確な等分をそのまま保全できない | D-07の非丸め方針に沿い、Step 2〜3の計算/API/保存精度と項目11の旧結果保全を統合する。小数桁を増やすだけで循環小数の問題が解決したとはしない |
| T-18 | 対局日時列がなくcreated_atで代用し、表示のタイムゾーン固定もない | D-16に従いStep 2〜4で対局/入力日時と日本時間表示を整備。D-17の未指定対局を期間だけでシーズンへ自動算入しない |

対応時期は計画であり、この一覧の掲載だけでは実装の承認にならない。新しい負債を見つけたら再現条件・影響・対象Stepを追記する。

## 目標API契約：設計確認9

この節は2026-11-17に統合したPhase 2.5の技術設計で、全APIが未実装または現行との差分を持つ。承認済みDを具体化した契約として、対応Stepの実装・Go/Web/Postmanの更新とQケースを揃える。上記の現行契約・JSON例はそのまま現状の参照に使い、稼働済みと混同しない。

| 項目 | 目標の型・意味 | 互換性と確認 |
| --- | --- | --- |
| 結果のpoint | `{"numerator":"499","denominator":"30"}` のような既約分数。双方とも10進整数文字列、分母は正、0は0/1 | 現行numberからobjectへの互換性変更。WebのtoFixed・point順ソート、Go型、DB、Postmanを同時に更新する。表示した小数を保存/集計へ再入力しない |
| league_id | 新規対局の対象リーグをUUIDで特定。未指定シーズンでも必須の文脈 | Goで所属・rule/season/参加者のリーグを検証。bodyの指定だけを権限根拠にしない。保存モデルは設計確認7/11で統合 |
| season_id | 保存入力はUUIDまたはNULL。省略も未指定として扱う | Goの現*intを変更。通算は有無を問わず、特定シーズンは一致IDだけを対象とする。フィルタの省略と未指定のみの検索は別に定義する |
| match_date | 新規入力はRFC 3339のオフセット付き日時、応答はUTCのZ付き文字列。既存日時不明はNULL | 現行のcreated_at代用を廃止する互換性変更。Webは日本時間で表示し、NULLなら記録日時として区別する |
| created_at | サーバーが設定する記録作成時刻。新規はUTCのZ付き文字列、旧値自体が不明ならNULL | 対局日時とは別で、クライアントによる上書きは許可しない。対局/記録日時が両方不明なら『日時不明』と示す |

pointの例は `499/30 = 16.6333…pt` の型説明であり、単体で対局保存を実行できるfixtureではない。負の分子は許可し、NaN/Infinity・分母0や負の分母・整数以外を正確値として受け入れない。保存入力のpoint/rankやrecorded_byは許可せず、Goが生成する。UUIDは文字列、versionは正の10進整数文字列、日時はRFC 3339、未設定値は明示NULLとして返す。対象一覧が空なら配列は[]、next_cursorはNULL。

### 共通の認証・検証・失敗契約

- health以外のGo APIはBearerとAuth主体/セッションを検証する。meの取得/本人の名前設定だけは初回設定未完了でも許可し、他は403 PROFILE_INCOMPLETE。me以外は参加者の不在を自動作成で解決せず、403 PROFILE_REQUIREDでme取得へ戻す。
- リーグAPIは対象の有効所属を要求する。非所属と存在を確認できないリーグIDは403 LEAGUE_ACCESS_DENIEDに統一。所属確認後にそのリーグの子IDが存在しない場合は404 NOT_FOUND。検索・番号解決・招待確認・参加だけは所属前の例外として下表の最小情報を返す。
- 変更bodyはJSON object、上限64KiB。未知/重複フィールド・不正な型・必須値の欠落・不正UUID/日時・範囲外は400 INVALID_INPUTとfield_errors。Content-Type不正は415、上限超過は413。認証を先に確認し、不正要求でDB副作用を起こさない。
- 書込みを伴うme以外の変更操作はclient_request_id（UUID）を要求する。新規対局以外の管理操作も操作種別/操作者/対象とhashを変更記録で対応付け、同じ操作の再送を二度適用しない。版を持つ対象の更新はversionも要求し、操作IDの再送判定を版の競合判定より先に行う。本人の名前設定は同じ名前の再送を安全に適用できるため操作IDを不要とし、自分のleaveは現在の所属を終了する冪等操作とする。
- 不正認証401 UNAUTHENTICATED、認可403 FORBIDDEN、版不一致409 VERSION_CONFLICT、同じ操作IDで内容違い409 IDEMPOTENCY_CONFLICT、状態不整合409 STATE_CONFLICT。鍵/DBの一時障害と処理待機上限は503 TEMPORARILY_UNAVAILABLE、予期しない実装エラーは500 INTERNAL_ERROR。いずれもSQL詳細・JWT・参加コードを本文へ出さない。
- CORSは許可したWeb originだけ、Authorization/Content-Typeを許可しOPTIONSは認証前に処理。Cookie認証をGoへ追加せず、ブラウザ/SSRともBearerを送る。本人/リーグの応答はprivate, no-storeとし共有キャッシュを禁止する。

共通エラーの型例：

```json
{"error":{"code":"INVALID_INPUT","message":"入力内容を確認してください","field_errors":{"players[0].raw_score":"100点単位で入力してください"},"request_id":"example-request-id"}}
```

field_errorsは入力不備の場合だけ返し、messageは表示用、分岐はcodeを使う。503の再試行は取得/計算なら同じ要求、保存/変更なら同じ操作IDと内容を維持する。401では更新可能なセッションをWebが1回更新して再送し、それでも失敗すれば安全な戻り先付きでログインへ。403は再ログインを繰り返さず、設定/所属/権限の状態を示す。

### me・リーグ基盤と参加のルート

『設定済』は有効な本人セッションと初回名前設定済み、『所属』は対象リーグへの有効所属、『運営』はowner/admin。IDを含むpathの子リソースは必ず同じleague_idで検索する。

| Method / Path | 条件・入力 | 成功・副作用 / 対象Step |
| --- | --- | --- |
| GET /api/health | 公開 | DB疎通200、失敗503。内部接続情報なし / Step 1 |
| GET /api/users/me | 本人JWT | 200 {id,name,profile_completed_at}。auth_idで検索/並行初回作成。初期名Player、完了時刻NULL。既存名を上書きしない / Step 1 |
| PATCH /api/users/me | 本人JWT、{name}のみ | 200で同じ本人型。D-24で検証し、初回だけ完了時刻も一括設定。以後の名前変更で完了時刻・他人のIDを変更しない / Step 1 |
| GET /api/leagues | 設定済 | 200 {leagues:[{id,name,group_number,my_role}]}、自分の有効所属だけ / Step 2 |
| POST /api/leagues | 設定済、{name,client_request_id} | 201 {league,rule}。番号/リーグ/初期owner所属/初期ルールを一括作成。シーズンは自動作成せず、初期非掲載 / Step 2 |
| GET /api/leagues/search | 設定済、q/cursor/limit | 200 {leagues,next_cursor}。掲載済みのid/name/group_numberだけ。参加コード・所属者・成績なし / Step 2 |
| POST /api/leagues/resolve | 設定済、{group_number} | 200で最小リーグ情報、番号なしは404。非掲載も番号で解決可。所属作成なし / Step 2 |
| POST /api/leagues/join-preview | 設定済、{group_number,code} | 200で最小リーグ情報とexpires_at。無効/期限切れ/失効は404 INVALID_INVITEに統一。所属作成なし / Step 2 |
| POST /api/leagues/{league_id}/join | 設定済、{code,client_request_id} | 200 {membership}。要求時点の招待を検証。未所属/退出/除名済みはmemberへ、有効所属は元roleを維持 / Step 2 |
| GET /api/leagues/{league_id} | 所属 | 200でリーグと本人role。一般情報に参加資格を含めない / Step 2 |
| PATCH /api/leagues/{league_id} | 運営、{name?,search_listed?,version,client_request_id} | 200、設定と変更記録を一括更新。owner_idは受け付けない / Step 5 |
| GET /api/leagues/{league_id}/participants | 所属、cursor/limit | 200 {participants,next_cursor}。id/name/kind/versionを持つ新規選択可能な有効参加者。legacyを除き、紐付け済みゲストは本人候補へまとめる / Step 2〜3 |
| POST /api/leagues/{league_id}/guests | 所属、{name,client_request_id} | 201 {participant}。ゲストと対象リーグ関連を一括作成。既存の同名を自動取得しない / Step 3 |
| PATCH /api/leagues/{league_id}/guests/{user_id} | 運営、{name,version,client_request_id} | 200。対象は未紐付けゲストだけ。登録者本人の名前はmeから変更 / Step 5 |
| GET /api/leagues/{league_id}/rules または /seasons | 所属、cursor/limit。rulesはavailable=true（既定）/false/all | 200 {rules,next_cursor} / {seasons,next_cursor}。別リーグを混ぜない。旧対局の条件確認には利用停止済みルールも取得可 / Step 2 |
| POST /api/leagues/{league_id}/rules | 運営、{name,default_points,return_points,uma:[4整数],client_request_id} | 201、新しいrule ID。S/Rは正の100点単位、R≥S、ウマ降順/合計0、全てDB整数範囲 / Step 2の初期版、Step 5の管理 |
| PATCH /api/leagues/{league_id}/rules/{rule_id} | 運営、{available,version,client_request_id}のみ | 200。計算条件の更新は400で拒否し、新版作成へ案内。旧対局は元rule IDを維持 / Step 5 |
| POST /api/leagues/{league_id}/seasons | 運営、{name,start_date?,end_date?,client_request_id} | 201、YYYY-MM-DDまたはNULL。期間逆転を拒否 / Step 2の基盤、Step 5の管理 |
| PATCH /api/leagues/{league_id}/seasons/{season_id} | 運営、{name?,start_date?,end_date?,version,client_request_id} | 200。使用済み期間の日付変更は409、名前だけの変更は可。締め操作なし / Step 5 |

me以外の名前はゲスト1〜30、リーグ/ルール/シーズン1〜100コードポイントで、前後空白・改行/制御文字の扱いはD-24と同じ。同名はIDで区別する。検索はUnicode NFKC・小文字化した名前の部分一致、qは2〜100コードポイント、%/_はワイルドカードでなく文字として扱う。元の表示名は検索正規化で置換しない。

### 対局・順位表・管理のルート

| Method / Path（/api/leagues/{league_id}配下） | 条件・入力 | 成功・副作用 / 対象Step |
| --- | --- | --- |
| POST /matches/calculate | 所属、{rule_id,players:[{user_id,raw_score}×4]} | 200 {rule_id,results}、DB書込みなし。4人・単位・合計・候補・ruleを検証してGoで正確値を生成 / Step 3 |
| POST /matches | 所属、{rule_id,season_id?,match_date,players:[4],client_request_id} | 初回201、同内容の再送200、同じmatch ID。記録者は本人。1対局/4結果/作成記録を一括保存 / Step 3 |
| GET /matches | 所属、season/status/cursor/limit | 200 {matches,next_cursor}、取消状態も区別して返す。seasonは下記、statusはall（既定）/valid/cancelled / Step 2の閲覧基盤、Step 5の取消表示 |
| GET /matches/{match_id} | 所属 | 200 Match型。別リーグのIDは404。管理用の変更理由/前後一式は含めない / Step 3 |
| PATCH /matches/{match_id} | 運営、作成入力の全項目＋reason/version/client_request_id（rule/season/date/playersは全置換） | 200 {match_id,applied_version}。再検証・再計算・4結果と変更記録を一括更新 / Step 5 |
| POST /matches/{match_id}/cancel | 運営、{reason,version,client_request_id} | 200 {match_id,applied_version}。状態と変更記録を一括更新。取消済みの別操作は409 / Step 5 |
| GET /matches/{match_id}/revisions | 運営、cursor/limit | 200 {revisions,next_cursor}。変更前後・理由・操作者、時刻と版を返す / Step 5 |
| GET /ranking | 所属、season | 200 {metric:"total_point",season,entries}。各entryは順位/本人ID/表示名/正確な合計point/対局数。取消を除外 / Step 5 |
| GET /members | 所属、cursor/limit | 200 {members,next_cursor}。所属管理に必要な参加者ID/現在名/role/status/version。Authメールは返さない / Step 2 |
| PATCH /members/{user_id} | owner、{role:"admin"または"member",version,client_request_id} | 200。対象は有効な登録者、現ownerの変更やbodyのowner指定は拒否 / Step 5 |
| POST /members/{user_id}/remove | owner、または対象がmemberの場合だけadmin。{reason,version,client_request_id} | 200。登録者の所属をremovedにする。owner本人とguest/legacyは対象外 / Step 5 |
| POST /leave | 所属、{client_request_id} | 200。本人をleftにし、ownerは409で引継ぎへ案内。原ID・成績は残す / Step 5 |
| GET /invites/current、POST /invites、POST /invites/{id}/revoke | 運営。変更はclient_request_id、失効はversionも要求 | GET200、発行201、失効200。発行時は旧共通招待を失効し、コード/リンクは運営だけへ返す / Step 2 |
| POST /participant-links | 所属、{guest_user_id,client_request_id} | 201で本人の申請/同意を記録。対応先の登録者IDはGoが本人から設定 / Step 3 |
| GET /participant-links | 所属、cursor/limit | 200。一般memberは本人の申請だけ、運営はリーグの申請/対応を閲覧 / Step 3 |
| POST /participant-links/{id}/approve または /reject | 運営、{confirmation_note,version,client_request_id} | 200。owner/adminの自己承認可。承認は同卓重複/他人への有効対応/循環を再確認 / Step 3 |
| POST /participant-links/{id}/revoke | owner、{reason,version,client_request_id} | 200、対応解除と記録のみ。原対局・登録者を削除しない / Step 5 |
| POST /owner-transfers | owner、{to_user_id,client_request_id} | 201 pending。対象は有効所属の登録者。現在のroleはまだ変更しない / Step 5 |
| POST /owner-transfers/{id}/accept または /cancel | acceptは指名本人、cancelは現owner。{version,client_request_id} | 200。accept時に現owner/両所属/期限を再確認し、owner参照と2人のroleを一括変更 / Step 5 |
| GET /events | 運営、cursor/limit | 200 {events,next_cursor}。所属/role/本人対応/招待/引継ぎ等の記録、秘密値は除外 / Step 5 |

Match型はid/league_id/rule_id/season_id/match_date/created_at/recorded_by/status/version/results。結果は原user_id、canonical_user_id、display_name、raw_score、rank、正確なpointを持つ。氏名変更や本人対応で表示名・本人IDの解決が変わっても、原IDと保存済み成績を変えない。取消済みのPATCH/取消解除ルートは初期範囲に設けない。

訂正/取消は同じ操作ID・同じ内容の再送なら元のapplied_versionを返し、新たに変更を適用しない。通常の版不一致は409。理由/confirmation_noteは前後空白除去後1〜500文字で必須。正確値の合計は同順位を1/1/3のように返し、表示安定化のID順で順位差を作らない。参加者範囲は成績のある登録者/ゲスト/退出・除名済みを含み、未参加者を0点で混ぜない。

### 絞り込み・ページング・試行制限

seasonは省略またはallで通算、unassignedでNULLのみ、UUIDで一致シーズンのみ。特定シーズン/未指定の違いを日時の範囲だけで置き換えない。limitは既定20、1〜100、cursorは版・検索条件・最後のソートキーをbase64urlにした不透明値として検証し、不正/条件違いは400。cursor自体を認可に使わない。

履歴は設計の日時/ID降順、検索は正規化名/id昇順、参加者は表示名/id昇順、rules/seasonsは作成時刻/id昇順、変更記録は時刻/id降順。現在状態が変わらない場合に重複/欠落なく辿れることをQ-26で確認する。並行訂正で日時/名前が変わった一覧は更新操作で先頭から再取得し、HTTPをまたぐ完全なDBスナップショットは保証しない。順位表は全対象を正確に集計してから順位を付け、取得ページ内だけで順位を計算しない。

招待の照合は本人＋リーグで10回/分、接続元IPで60回/分を初期の技術上限とし、超過は429 RATE_LIMITED/Retry-After。検索は本人30回/分。複数APIインスタンスでも共有するカウンタをDBで短く更新し、攻撃的な試行のたびに参加者/所属を作らない。Authのメール送信・ログイン試行制限はSupabase側の設定を確認し、その429もWebで再試行待ちにする。上限は運用設定で調整でき、SLOや想定利用規模の確定値とは扱わない。

### 登録・確認・回復とWebの契約

資格情報の発行/保存はGoへ追加せず、Supabase Authを使う。WebはsignUp/signInWithPassword/resetPasswordForEmail/updateUserと、localを明示したsignOutを扱う。確認メールはtoken_hashを使ってWebのGET /auth/confirmへ戻し、許可したemail/recoveryだけをverifyOtpで検証する。成功応答へ更新Cookieを引き継ぎ、token_hashを除去して303で遷移する。回復は/password/update、登録は名前設定を優先して安全な戻り先へ。失敗は/auth/errorから再送/回復依頼へ戻す。

[Supabaseのパスワード認証手順](https://supabase.com/docs/guides/auth/passwords) と [メールテンプレート仕様](https://supabase.com/docs/guides/auth/auth-email-templates) に基づく採用設計。token_hash付きテンプレート・Site URL・許可URL・Email確認・配送設定は実装環境で揃えてQ-21を実行する。通常Cookieの復元/更新を毎回のログイン入力へ置き換えず、確認失敗や一時障害では通常利用完了と表示しない。

### Stepごとの切替

Step 1は既存4保護APIへ認証を追加し、me/名前設定とAuth導線を完成させる。対局の旧body/数値形式はこの段階で最終契約へ一括変更しない。Step 2はリーグ/参加/参照APIと履歴の所属制限、Step 3は新しい計算/保存/ゲスト/正確値の契約、Step 4は主要導線、Step 5は管理/順位表を実装する。

Step 2で旧記録APIを認証だけで公開し続けない。所属を確定できない旧要求は403/409で拒否し、Step 3の新しい記録契約が揃うまで記録導線を停止できる開発用の切替を置く。新旧の対局APIを同時に実データ運用しない。新契約への切替時に旧POST /api/matches・calculateは410 API_RETIRED、旧GET /api/matchesはleague_id必須の所属検証付き移行アダプタを経て撤去する。必要な最小のWeb呼出し変更は対応APIのStepに含め、Step 4のホーム完成を先行したとは扱わない。公開運用の可否は全対象Stepの受入後に判断する。

## 目標画面・状態・導線：設計確認10

D-39に従いスマホ対応Webを対象とする。以下は対応Stepで実装する画面設計であり、現在のURLが全て存在するという意味ではない。リーグUUIDをpathへ含め、別リーグへの切替で取得データ・cursor・roleを共有しない。

| URL | 正常時の操作と遷移 | 空・失敗・復帰 / Step |
| --- | --- | --- |
| /login、/signup | ログイン/自己登録、確認待ち・再送・回復依頼へのリンク。検証済み本人をmeへ接続 | 送信中は重複を抑止、資格情報/配送/通信の失敗を区別。再訪で有効なセッションなら入力省略 / Step 1 |
| /auth/confirm、/auth/error | token_hash検証、Cookie更新後に秘密値をURLから除去。登録は名前設定、recoveryは/password/updateへ | 期限切れ/再利用/不正typeは変更を完了扱いにせず再依頼。外部nextは採用しない / Step 1 |
| /password/reset、/password/update | 回復依頼、認証済み本人の新パスワード入力。更新後は同じ参加者で安全な入口へ | 依頼受付はアカウント存在・実配送の証明にしない。失敗時は入力修正/再依頼、パスワードを下書き保存しない / Step 1 |
| /profile/setup、/account | 初回表示名を設定。以後は本人の名前変更と任意のlocalログアウト | 初回は完了まで通常画面へ進ませない。保存失敗時は名前入力保持。アプリ全体の本人状態を更新 / Step 1 |
| / | 所属リーグ一覧、作成、名前検索/番号入力。選択したリーグのホームへ | 未所属は作成/参加へ。取得失敗は再試行。初期テンプレートを置き換える / Step 4 |
| /leagues/new、/leagues/search | 作成者をownerとしてリーグ作成、掲載リーグ検索/番号解決 | 同名は番号で識別。0件を失敗扱いにしない。非掲載設定は作成時false / Step 2の最小接続・Step 4の入口 |
| /join/{group_number} | fragmentのコード/手入力を確認し、本人の参加操作で所属を作る | 登録/ログイン/名前設定後に戻る。期限切れは新招待を依頼。既存所属は通常のリーグへ、再参加はmember / Step 2の参加・Step 4の導線 |
| /leagues/{id} | リーグホームから記録・履歴・順位表・設定へ。roleに応じて操作を表示 | 未所属/退出/除名後は保護データを破棄し、参加可能な入口へ。API拒否を0件と混同しない / Step 4 |
| /leagues/{id}/matches/new | DBからrule/season/参加者を取得。未指定シーズン可。4人・素点・対局日時を入力→計算確認→保存→履歴 | 候補取得失敗時は固定メンバーへfallbackしない。入力保持・正確なpoint表示・結果不明時の同一操作再送 / Step 3 |
| /leagues/{id}/matches、/matches/{match_id}（同リーグ配下） | 日本時間の履歴・詳細、通算/シーズン/未指定と取消状態、追加取得 | 0件は入力へ、503は再試行。旧対局日時NULLは『記録日時』を表示。取得失敗で既存の正しい一覧を空へ置き換えない / Step 2〜4 |
| /leagues/{id}/ranking | 合計point・対局数・対象範囲・同順位、保存した正確値で比較 | 取消は含めず、対象0件なら空状態。同点の表示順を順位差と見せない / Step 5 |
| /leagues/{id}/settings | 招待/掲載/ルール/基本シーズン、所属/role/引継ぎ、本人紐付け/解除と操作記録 | 権限表に沿う表示。参加コードは運営のみ。version競合は再取得後に差を確認して再送 / Step 5（招待・紐付けは対応Stepにも最小接続） |
| /leagues/{id}/matches/{match_id}/edit | owner/adminの訂正・取消。元値と変更後、理由を確認して送信 | memberの直URLは拒否。保存/版競合/取消済みを区別。成功後は履歴と順位表を再取得 / Step 5 |

### 共通の本人状態と入力保持

Webはサーバー/ブラウザのSupabaseクライアントを分け、Proxyの通常/redirect応答へ更新Cookieを引き継ぐ。サーバーで検証したセッションとGoのmeから本人状態を作り、Providerは表示用の共有状態として使う。取得中・未設定・有効・更新不能・内部障害を区別し、Provider内のroleやsubをGoの認可の代替にしない。ユーザーが変われば全リーグデータと下書きを破棄する。

D-27のreturnToはAPP_ORIGINを基準に検証したアプリ内の相対pathだけ。認証画面への循環、//・外部scheme・制御文字・不正な二重エンコードを拒否し、初回名前設定を優先してから戻る。戻り先なしはStep 1では/matches、Step 4以降は/。旧/matches系の直URLは選択済みで有効なリーグへ案内し、複数候補なら選択画面を挟む。未所属なら参加入口へ進み、全件履歴を表示しない。

未保存の対局入力は同じタブのsessionStorageに本人ID/league IDで分離して保持し、保存成功・本人切替・localログアウト・24時間経過で削除する。保持するのは参加者ID/素点/rule/season/date/保存操作IDと結果不明の状態で、資格情報や表示用のpointは保存しない。結果不明の間は入力と操作IDを固定し、401後も同じ本人での復帰時だけ再送する。別タブ・別端末・ブラウザ終了後の下書き復元を保証しない。

参加コードは一時的な参加フローだけに保持し、完了/失効/ログアウトで消す。メール確認を別タブや端末で開いてコードを引き継げない場合は、元の招待リンクを開き直すかコードを入力する導線を出す。確認が終わっただけでリーグ参加を自動実行しない。

localログアウトはSupabaseへlocalを明示し、成功後に同じセッションのタブの本人状態・取得データ・下書きを破棄して/loginへ。失敗時は認証側の終了を完了と表示しない。Goは[Supabaseのセッション仕様](https://supabase.com/docs/guides/auth/sessions#how-to-ensure-an-access-token-jwt-cannot-be-used-after-a-user-signs-out)に沿ってAuthのsession_id行を確認し、終了後に開始した古いJWT要求を拒否する。すでに処理中の要求との順序は設計の共有ロックとQ-10で確認する。

### 表示と対応端末

正確なpointは有限小数ならそのまま、循環小数なら小数4桁までの省略＋…を表示し、詳細で元の分数を確認できるようにする。省略値で再計算・保存しない。raw_scoreは点、pointはptとして区別する。100点の省略入力を提供する場合もラベル/入力例で単位を示し、小数入力を黙ってMath.truncで変換しない。取得/保存エラーは表示文と再試行先を示し、色だけで区別しない。

対象はiOS Safari/Android ChromeとPC Chrome/Safariの検証時点の現行・1つ前のメジャー版を基準とし、実行したOS/ブラウザ版をPRへ残す。幅360/390/768/1280 CSS px、200%文字拡大、縦横表示、タッチとキーボードで主要操作を確認する。入力のラベル、エラーと対象項目の対応、処理中の二重操作抑止、モーダルのフォーカス復帰、横スクロール/文字切れをQ-19/Q-26へ含める。PWA/オフライン記録/ストア配布は今回の実装対象にしない。

## API契約を変更するときの記録

現行APIは上の記述と例を正本にする。OpenAPI、APIバージョニング、統一エラー形式はまだ導入していない。文書だけで将来の形式へ置き換えて、現行クライアントがその契約で動くように見せない。

変更PRでは、method/path、認証・認可条件、入力型と必須/NULL、応答型、ステータス、DB副作用、互換性、確認ケースを記す。Goモデル・SQL・Web型/呼び出し・Postman・本書を同時に更新する。IDと表示名、season型、pointの計算主体は、契約変更に特に影響する。

共通エラーのcode/表示文/field_errorsとステータスは上記の目標契約を使い、対応する実装PRでGo/Web/PostmanとQケースを更新する。SQLや接続情報を利用者へ返さず、実装と受入の証拠が揃ってから現行契約の記述を切り替える。

対局保存の再送はD-13の操作ID、point/rankはGo生成と未知フィールド拒否の契約に従う。ボタンの無効化だけで冪等性を保証しない。APIの数や外部クライアントが増えたら機械可読なOpenAPIを検討し、その場合は手書きの型一覧と二重管理しない。

### 互換性に影響する変更の見分け方

| 変更例 | 確認する影響 | 更新・確認するもの |
| --- | --- | --- |
| Bearer必須化 | 同じbodyでも旧クライアントは401になる | ブラウザ、SSR、Postmanの転送・環境設定、Q-06〜Q-10 |
| 履歴user_idを名前から永続IDへ変更 | 型がstringのままでも意味が変わる。名前表示をそのままにできない | 表示名の別項目、Go/Webの型・表示・ID参照、Q-15 |
| season_idを整数から実DBの型へ統一 | 入力値・NULL・旧データの解釈が変わる | Go/Web/seedの型、移行・旧値の扱い、Q-16 |
| pointをnumberから正確な分数へ変更 | 数値の表示・比較・合計・保存の型が変わる | Go/API/Web/DB/Postmanと旧値の移行、Q-03/Q-12/Q-16 |
| point/rankをGoで再計算する | 値の採用・不一致拒否によって、既存の送信例と保存結果が変わる | 保存入力の契約、計算仕様、Q-11/Q-12 |
| 所属リーグの制限を適用する | 以前返ったデータや成功した書込みが拒否される | D-11/D-12、取得範囲・エラー、Webの権限状態、Q-14/Q-17 |
| レスポンスの任意項目を追加する | 通常は既存項目を保てるが、厳密な検証や全利用側への影響を確認する | 型・schema・利用箇所、例、必要な回帰確認 |
| 項目削除・改名・必須化・エラー形式変更 | 旧クライアントの解釈・送信が成立しない可能性がある | 利用者一覧、適用順、互換期間または同時反映、対象Qケース |

PRで影響する利用側を列挙し、API/Web/DBの適用順と旧版との同時稼働の可否を説明する。互換性のある変更と、同時更新が必要な変更を同じ手順で扱わない。バージョン付きAPIや互換期間を導入するかは、実際の外部クライアント・運用環境に応じて判断する。

## 2-3の参照API実装

| GET | 応答 | 範囲 |
| --- | --- | --- |
| `/api/leagues` | `{leagues:[{id,name,group_number,my_role}]}` | 本人の有効所属 |
| `/api/leagues/{league_id}` | `{league:{id,name,group_number,my_role}}` | 対象リーグでの本人role |
| 同 `/participants` | `{participants:[{id,name,kind,version}],next_cursor}` | 有効な登録参加者・ゲスト |
| 同 `/members` | `{members:[{user_id,name,kind,role,status,version}],next_cursor}` | active/left/removedの所属。legacyは除外 |
| 同 `/rules` | `{rules:[{id,name,default_points,return_points,uma,calculation_version,available,version}],next_cursor}` | `available=true` が既定。`false`、`all` も指定可。legacy版は除外 |
| 同 `/seasons` | `{seasons:[{id,name,start_date,end_date,version}],next_cursor}` | UUID。日付はYYYY-MM-DDまたはNULL |

JWT・有効セッション・設定済み本人を確認し、その永続IDと指定リーグのactiveなregistered所属を照合する。存在しないUUIDと非所属は同じ403。構文不正なUUID・許可外、重複または空の一覧queryは400。ページは既定20、1〜100。参加者・所属は名前/ID、rule/seasonは作成日時（NULL末尾）/IDの昇順。cursorを本人・リーグ・一覧種類・絞り込みに結び付ける。ページングのcursorは認可の代わりにしない。
