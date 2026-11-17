# MJ-Stats Web

MJ-StatsのNext.js / React / TypeScriptフロントエンド。プロダクト全体の入口は [ルートREADME](../README.md)、仕様・設計・作業方針は [doc/README.md](../doc/README.md) を参照する。

## 環境構築

[環境構築・運用](../doc/setup-and-operations.md) でNode.js、Webの環境変数、API、DB、Supabase Authの前提を準備する。設定値やDB初期化手順をこのREADMEへ重複させない。

`web` ディレクトリで実行する。

```bash
npm ci
npm run dev
```

開発サーバーのURLは起動ログを確認する。現在の機能を確認する入口は `/login`。`/` はまだプロダクトのホームではない。各画面の実装と制限は [機能・API仕様](../doc/features-api.md) を参照する。

## 変更時の確認

```bash
npm run lint
npx tsc --noEmit
npm run build
```

これらに加えて、変更した画面・認証・API通信を [品質・受入確認](../doc/quality-and-acceptance.md) に沿って確認する。Step 1で `npm run test:auth` と専用ローカルDB/Authを使う `npm run test:browser` を追加した。ビルドだけで受入済みとは判断せず、未実施の端末/共有環境を区別する。

AIエージェントは [AGENTS.md](AGENTS.md) を読み、インストールされたNext.jsの付属ドキュメントを確認する。
