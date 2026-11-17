# MJ-Stats

サークルや麻雀コミュニティの対局を記録し、成績分析とSNSへ共有できるリザルト画像を通じて楽しむアプリケーション。

## 初めに読むもの

- [ドキュメントの入口](doc/README.md)：文書の役割、読む順番、更新先。
- [要件と業務ルール](doc/requirements.md)：利用者、必要な振る舞い、守る条件。
- [ロードマップ](doc/product-roadmap.md)：現在の工程と完了条件。
- [環境構築・運用](doc/setup-and-operations.md)：必要な環境、設定、起動、確認方法。

現在は **Phase 2.5 / Step 2：リーグ・ルール基盤**。Step 1は開発者完了承認・PR #8マージ済み。Step 2着手承認を受け、最初の区分2-1「リーグ・所属のDB基盤」だけを実装・検証した。Step 2全体は途中で、リーグAPI/認可・履歴制限は後続区切り。2-1の適用先は専用ローカルと隔離コピーで、元共有DB・既存QAは変更していない。実装範囲と制限は [機能・API仕様](doc/features-api.md)、結果は [品質文書](doc/quality-and-acceptance.md#step-2--2-1の検証記録2026-11-18) を参照する。

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
