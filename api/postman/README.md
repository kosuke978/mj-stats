# MJ-Stats Postman 実行手順

## 1) APIを起動
`api` ディレクトリで以下を実行してください。

```bash
go run .
```

## 2) Postmanでコレクションを開く
このリポジトリの Postman リソースを開くと、以下のリクエストが使えます。

- `0. Health Check`
- `1. Calculate Match Points`
- `2. Create Match`

Postmanデスクトップを使う場合は、以下の2ファイルを Import してください。

- `postman/export/MJ-Stats.postman_collection.json`
- `postman/export/MJ-Stats.local.postman_environment.json`

## 3) 変数を確認
グローバル変数 `base_url` を利用しています。

- 既定値: `http://localhost:8080`
- ポート変更時は `base_url` だけ更新してください

## 4) 実行順
1. `0. Health Check`（API/DB接続確認）
2. `1. Calculate Match Points`（ポイント計算）
3. `2. Create Match`（DB保存）

## 5) 失敗しやすいポイント
- `Health Check` が 500 の場合、`DATABASE_URL` が未設定 or DB未接続の可能性があります
- `Create Match` はDB書き込みが必要です。Supabase接続情報を `.env` に設定してください
- `Create Match` の `rule_id` はDBの型に合わせる必要があります。現在の環境ではUUIDが必要なため、`1` ではなく既存のUUID（例: `YOUR_RULE_UUID`）を指定してください

## 6) `rules` が0件の場合（`rule_id` が取れない場合）
Supabase SQL Editorで以下を実行して、テスト用ルールを1件作成してください。

```sql
insert into public.rules (name, uma_1, uma_2, uma_3, uma_4)
values ('Default Rule', 20, 10, -10, -20)
returning id;
```

返ってきたUUIDを `2. Create Match` の `rule_id` に設定してください。
