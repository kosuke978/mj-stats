# MJ-Stats

サークルや麻雀コミュニティの対局を記録し、成績分析とSNSへ共有できるリザルト画像を通じて楽しむアプリケーション。

## 初めに読むもの

- [ドキュメントの入口](doc/README.md)：文書の役割、読む順番、更新先。
- [要件と業務ルール](doc/requirements.md)：利用者、必要な振る舞い、守る条件。
- [ロードマップ](doc/product-roadmap.md)：現在の工程と完了条件。
- [環境構築・運用](doc/setup-and-operations.md)：必要な環境、設定、起動、確認方法。

現在は **Phase 2.5 / Step 3「フォーム浄化・ゲスト永続化」**。所属リーグの履歴から対局を入力し、ゲストの再利用、Goでの分数計算・保存、履歴での確認ができます。工程と受入結果は [ロードマップ](doc/product-roadmap.md) を参照してください。

## リポジトリ構成

| 場所 | 内容 |
| --- | --- |
| `web/` | Next.js / React / TypeScriptのフロントエンド |
| `api/` | Go / GinのAPIとPostgreSQL接続 |
| `supabase/` | 専用ローカル環境、migration、限定Auth権限、メールテンプレート |
| `scripts/` | ローカル/専用QAの設定・起動・移行検証（共有環境へ適用しない） |
| `api/postman/` | 既存APIのリクエスト例 |
| `doc/` | 要件、設計、判断、確認、開発・運用手順 |

WebとAPIは別プロセスで起動する。事前にSupabase Authと必要なDBスキーマ・データを準備する。専用ローカル環境とbaseline/認証migrationを管理する。seedだけでは初期構築できない。コマンドと環境変数は [構築手順](doc/setup-and-operations.md) に集約する。

## 開発への参加

[開発運用](doc/development-workflow.md) に従い、作業ブランチとPRで変更する。各PRのマージと次Stepへの着手には開発者の明示承認が必要。仕様の決定は [判断記録](doc/decisions.md)、実行した確認の証拠はPRへ残す。

AIエージェントは [AGENTS.md](AGENTS.md) を入口に、現在の依頼に関連する文書とコードを読む。
