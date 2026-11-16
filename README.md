# MJ-Stats

サークルや麻雀コミュニティの対局を記録し、成績分析とSNSへ共有できるリザルト画像を通じて楽しむアプリケーション。

## 初めに読むもの

- [ドキュメントの入口](doc/README.md)：文書の役割、読む順番、更新先。
- [要件と業務ルール](doc/requirements.md)：利用者、必要な振る舞い、守る条件。
- [ロードマップ](doc/product-roadmap.md)：現在の工程と完了条件。
- [環境構築・運用](doc/setup-and-operations.md)：必要な環境、設定、起動、確認方法。

現在は **Phase 2.5 / Step 1：認証基盤の完成** に取り組む段階。対局入力・計算・保存・履歴表示の実装はあるが、JWT署名検証、API保護、ゲスト保存、Goでの点数整合性確認には未完了の部分がある。実装範囲と制限は [機能・API仕様](doc/features-api.md) を参照する。

## リポジトリ構成

| 場所 | 内容 |
| --- | --- |
| `web/` | Next.js / React / TypeScriptのフロントエンド |
| `api/` | Go / GinのAPIとPostgreSQL接続 |
| `api/postman/` | 既存APIのリクエスト例 |
| `doc/` | 要件、設計、判断、確認、開発・運用手順 |

WebとAPIは別プロセスで起動する。事前にSupabase Authと必要なDBスキーマ・データを準備する。DDL・マイグレーションはまだ管理されておらず、seedだけで新しいDBを構築できる状態ではない。コマンドと環境変数は [構築手順](doc/setup-and-operations.md) に集約する。

## 開発への参加

[開発運用](doc/development-workflow.md) に従い、作業ブランチとPRで変更する。各PRのマージと次Stepへの着手には開発者の明示承認が必要。仕様の決定は [判断記録](doc/decisions.md)、実行した確認の証拠はPRへ残す。

AIエージェントは [AGENTS.md](AGENTS.md) を入口に、現在の依頼に関連する文書とコードを読む。
