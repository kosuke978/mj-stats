# MJ-Stats Postman

ローカルの2-3対応Goとmigrationを使用します。インポート対象は `export/MJ-Stats API v2.0.postman_collection.json` と `export/MJ-Stats.local.postman_environment.json` です。

1. `base_url` を専用ローカルGoに合わせ、同じローカルAuthの本人access tokenを `access_token` のローカル値へ設定します。
2. Health → Get Me → 必要なら Set My Display Name → My Leagues の順で確認します。My Leaguesで返った有効所属のIDを `league_id` に指定します。
3. League、Participants、Members、Rules、Seasons、Get Matchesで同じリーグを参照します。別リーグや存在しないUUIDは403。履歴で所属先にないseason UUIDは404です。
4. 一覧は `limit` が既定20、1〜100。次ページは同じ本人・リーグ・一覧・filterの `next_cursor` を使用します。Rulesは `available=true/false/all`、履歴は `season=all/unassigned/UUID` に対応します。履歴のpointは保存済み数値です。
5. History Without Leagueは400。旧計算・保存POSTは409で処理を停止します。Missing BearerとInvalid JWTは401です。

トークンを共有・exportへ含めません。実行範囲と証跡は [品質・受入](../../doc/quality-and-acceptance.md) を参照してください。
