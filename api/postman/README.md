# MJ-Stats Postman

ローカルのStep 5対応Goとmigrationを使用します。インポート対象は `export/MJ-Stats API v2.0.postman_collection.json` と `export/MJ-Stats.local.postman_environment.json` です。

1. `base_url` を専用ローカルGoに合わせ、同じローカルAuthの本人access tokenを `access_token` のローカル値へ設定します。
2. Health → Get Me → 必要なら Set My Display Name → My Leagues の順で確認します。My Leaguesで返った有効所属のIDを `league_id` に指定します。
3. League、Participants、Members、Rules、Seasons、Get Matchesで同じリーグを参照します。別リーグや存在しないUUIDは403。履歴で所属先にないseason UUIDは404です。
4. 一覧は `limit` が既定20、1〜100。次ページは同じ本人・リーグ・一覧・filterの `next_cursor` を使用します。Rulesは `available=true/false/all`、履歴は `season=all/unassigned/UUID` に対応します。履歴のpointは `{"numerator":"499","denominator":"30"}` のような既約分数です。
5. History Without Leagueは400。旧計算・保存POSTは410 `API_RETIRED`で処理を停止します。Missing BearerとInvalid JWTは401です。

トークンを共有・exportへ含めません。実行範囲と証跡は [品質・受入](../../doc/quality-and-acceptance.md) を参照してください。

リーグの作成を確認する場合は、名前設定後に `client_request_id` に新しいUUIDを設定し、Create Leagueを実行します。初回は201、同じ本人・UUID・リーグ名で再送すると200で同じリーグと初期ルールが返ります。同じUUIDで名前だけ変えると409 `IDEMPOTENCY_CONFLICT` です。別のリーグを作るときは新しいUUIDを使います。返された `league.id` を `league_id` に入れると、My Leagues・League・Rulesで初期状態を確認できます。

招待管理は[招待鍵を設定した専用ローカルGo](../../doc/setup-and-operations.md#step-2--2-5のローカル適用と招待鍵)で確認します。対象リーグのownerまたはadminのBearerを使用します。

1. Current Inviteは200。未発行・期限切れ・失効後は `{"invite":null}`。
2. Issue Inviteは新しい `client_request_id` で201、同じIDの再送は200。別のIDで発行すると以前の招待は失効します。
3. Revoke Inviteは `invite_id` と `invite_version` に応答のIDと版を指定し、新しい操作IDで実行します。200で失効し、同じ操作IDと版の再送も200。別操作で古い版を送ると409です。

コードやリンクは共有変数、保存済みレスポンス、共有履歴、exportに入れません。

Search Leaguesは掲載名だけを検索し、Resolve League Numberは非掲載の番号も解決します。Preview Joinは所属を作らず、Join Leagueで明示的に参加します。隔離環境で確認するときだけ `invite_code` の空のsecret変数にローカル値を一時設定し、確認後に消去します。参加コードの形式不正は400、形式が正しいコードの不一致・期限切れ・失効は404です。試行制限は429とRetry-Afterです。


## 対局記録とゲスト紐付け

1. Create Guestで `client_request_id` を新しく設定し、ゲストを作成します。再参加時はParticipantsの既存IDを使います。
2. Rulesの利用可能な `rule_id` と、Participantsから異なる4人の `player_1_id`〜`player_4_id` を設定し、Calculate League Matchを実行します。33,300 / 33,300 / 33,300 / 100点の例では、標準ルールで1位3人が各499/30ptです。
3. Save League Matchの操作IDを新しくし、対局日時（オフセット付き）、必要なら同じリーグのシーズンUUIDを設定します。例の `null` は未指定です。応答の `id` を `match_id` に設定し、League Match DetailとGet Matchesを確認します。再送は同じ操作ID・同じ内容を送ります。
4. 紐付けを申請する本人のBearerと `guest_user_id` でRequest Participant Linkを実行します。List Participant Linksで申請IDと版を取得します。運営者のBearerで `link_id`、`link_version`、新しい操作ID、確認内容を指定し、ApproveまたはReject Participant Linkを実行します。
5. 承認後、Participantsには有効所属の本人が表示され、紐付け済みゲストは新規候補から外れます。旧ゲストIDの新規計算・保存は409。保存済みの同一操作を再送し、同じ対局IDと現在の状態が返ることを確認します。

## 順位表と管理

1. Rankingで通算とシーズンを確認します。訂正・取消ではMatch Detailの `version` を `object_version` に設定し、運営のBearerで実行します。200の `applied_version`、Match Revisions、通常履歴と順位表を照合します。
2. League Settings、Members、Rules、Seasonsで現在の版を取得してから管理操作を送ります。メンバー操作では `target_user_id`、引継ぎでは提案後の `transfer_id`、シーズン変更では `season_id` を指定します。指名と同意は別の本人のBearerで実行します。
3. 本人対応を解除するときはList Participant Linksの `link_id` と `link_version` を指定し、ownerのBearerでRevoke Participant Linkを実行します。League Eventsと順位表で変更を確認します。
4. 新しい操作は新しいUUIDを使い、再送は同じ操作ID・同じ本文で送ります。操作ID再利用や版競合は409。運営権限があるリーグとmemberのリーグを切り替えて403を照合します。

Update League Settingsは `PATCH /api/leagues/{league_id}/settings` です。Update Seasonの例は名前だけを送信し、両方の日付を維持します。期間を更新する場合、値を送った境界だけが変わり、明示した `null` でその境界を解除します。使用済み期間の変更・解除は409です。同じ操作IDの本文で日付の省略をnullに変えた場合も409になります。

v1のコレクションは当時の契約の記録です。
