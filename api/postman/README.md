# MJ-Stats Postman

ローカルのStep 2対応Goとmigrationを使用します。インポート対象は `export/MJ-Stats API v2.0.postman_collection.json` と `export/MJ-Stats.local.postman_environment.json` です。

1. `base_url` を専用ローカルGoに合わせ、同じローカルAuthの本人access tokenを `access_token` のローカル値へ設定します。
2. Health → Get Me → 必要なら Set My Display Name → My Leagues の順で確認します。My Leaguesで返った有効所属のIDを `league_id` に指定します。
3. League、Participants、Members、Rules、Seasons、Get Matchesで同じリーグを参照します。別リーグや存在しないUUIDは403。履歴で所属先にないseason UUIDは404です。
4. 一覧は `limit` が既定20、1〜100。次ページは同じ本人・リーグ・一覧・filterの `next_cursor` を使用します。Rulesは `available=true/false/all`、履歴は `season=all/unassigned/UUID` に対応します。履歴のpointは保存済み数値です。
5. History Without Leagueは400。旧計算・保存POSTは409で処理を停止します。Missing BearerとInvalid JWTは401です。

トークンを共有・exportへ含めません。実行範囲と証跡は [品質・受入](../../doc/quality-and-acceptance.md) を参照してください。

リーグの作成を確認する場合は、名前設定後に `client_request_id` に新しいUUIDを設定し、Create Leagueを実行します。初回は201、同じ本人・UUID・リーグ名で再送すると200で同じリーグと初期ルールが返ります。同じUUIDで名前だけ変えると409 `IDEMPOTENCY_CONFLICT` です。別のリーグを作るときは新しいUUIDを使います。返された `league.id` を `league_id` に入れると、My Leagues・League・Rulesで初期状態を確認できます。

招待管理は[招待鍵を設定した専用ローカルGo](../../doc/setup-and-operations.md#step-2--2-5のローカル適用と招待鍵)で確認します。対象リーグのownerまたはadminのBearerを使用します。

1. Current Inviteは200。未発行・期限切れ・失効後は `{"invite":null}`。
2. Issue Inviteは新しい `client_request_id` で201、同じIDの再送は200。別のIDで発行すると以前の招待は失効します。
3. Revoke Inviteは `invite_id` と `invite_version` に応答のIDと版を指定し、新しい操作IDで実行します。200で失効し、同じ操作IDと版の再送も200。別操作で古い版を送ると409です。

コードやリンクは共有変数、保存済みレスポンス、共有履歴、exportに入れません。

Search Leaguesは掲載名だけを検索し、Resolve League Numberは非掲載の番号も解決します。Preview Joinは所属を作らず、Join Leagueで明示的に参加します。隔離環境で確認するときだけ `invite_code` の空のsecret変数にローカル値を一時設定し、確認後に消去します。参加コードの形式不正は400、形式が正しいコードの不一致・期限切れ・失効は404です。試行制限は429とRetry-Afterです。
