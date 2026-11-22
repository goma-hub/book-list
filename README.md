# book-list

読書記録アプリの Cloudflare Workers + React + Vite 構成です。

## 起動方法

```powershell
npm install
npm run dev -- --host localhost --port 5173 --strictPort
```

ローカル開発サーバーは Vite と Cloudflare Vite Plugin で起動します。

## ローカルの認証設定

プロジェクト直下の `.dev.vars` に以下を設定します。このファイルは Git の追跡対象から除外しています。

```dotenv
BETTER_AUTH_SECRET="32文字以上のランダムな値"
BETTER_AUTH_URL="http://localhost:5173"
```

`BETTER_AUTH_SECRET` の例はプレースホルダーです。実際にはランダム生成した値を使用してください。`BETTER_AUTH_URL` は開発サーバーの URL と一致させます。

ローカル DB のマイグレーションは以下で適用します。

```powershell
npx wrangler d1 migrations apply book-list-db --local
```

`0003_books_auth_user.sql` は既存の練習用読書記録と旧 `users` テーブルを削除し、`books` を Better Auth の `user` テーブルに紐づく構造へ変更します。

`0004_books_photo_key.sql` は既存の読書記録を残したまま、R2 写真の保存先を記録する `photo_key` 列を追加します。写真 API を使用する環境では、このマイグレーションを適用してから新しいコードを起動してください。本番 D1 の未適用マイグレーションは、適用前に必ず確認してください。

## 写真の保存

`wrangler.jsonc` の `BOOK_PHOTOS` は、非公開の R2 バケット `book-list-photos` に接続します。ローカル開発では R2 のローカル保存領域を使用します。R2 の公開 URL や API トークンは必要ありません。

ログインユーザーは、新しい読書記録を作る際や既存の記録から、JPEG・PNG・WebP 形式の写真をアップロードできます。上限は 1 枚 5 MB です。画像本体は R2、保存キーは D1 の `books.photo_key` に保存します。写真の取得・変更時は Worker がセッションと読書記録の所有者を確認します。従来の写真 URL 入力も利用でき、R2 写真がある場合はそちらを優先表示します。

## 開発ルール

- 依頼された範囲だけを確認・修正する
- 問題解決に不要な調査や大規模な変更は行わない
- まず原因を特定し、必要最小限の修正を行う
- 修正後の確認も、原則として変更した範囲に関係するチェックだけ実行する
- 全体チェックは、明示的に依頼された場合のみ実行する
- npm install は必要性を確認してから行う
- node_modules やキャッシュ等の削除は、明示的に依頼された場合のみ行う
- GitHub への commit / push は、明示的に依頼された場合のみ行う
- コマンドが長時間進まない場合は、無理に待たず停止して状況を報告する
- 調査を大きく広げる必要がある場合は、勝手に進めず先に報告する

## 主なコマンド

```powershell
npm run dev
npm run build
npm run preview
npm run deploy
```

## デプロイ方法

本番で認証を使うには、本番用の `BETTER_AUTH_SECRET` と公開 URL の `BETTER_AUTH_URL` を設定し、本番 D1 にマイグレーションを適用する必要があります。ローカルの `.dev.vars` とローカル DB の内容は、本番には反映されません。`0003_books_auth_user.sql` は本番への適用時にも既存の練習データを削除します。

Cloudflare へのデプロイは、次のコマンドで実行します。

```powershell
npm run deploy
```

このコマンドは Vite のビルド後に Wrangler でデプロイします。Cloudflare Vite Plugin がビルド時に `assets.directory` を含むデプロイ用設定と `.wrangler/deploy/config.json` を生成し、Wrangler はその設定を使用します。

ビルド前に `npx wrangler deploy` だけを実行すると、`assets` の `directory` がないというエラーになります。手動で実行する場合は、先にビルドしてください。

```powershell
npm run build
npx wrangler deploy
```

## 現在の実装範囲

- React + Vite のフロントエンド
- Cloudflare Workers の API エントリ
- Cloudflare Vite Plugin による同一プロジェクト構成
- `/api/health` による Worker API 疎通確認
- D1 を使用する読書記録の登録・一覧 API（`/api/books`）
- Better Auth 1.7.7 によるメールアドレス・パスワード認証（`/api/auth/*`）
- 新規登録・ログイン・ログアウト画面
- セッション確認による未ログイン時の API 拒否と、ユーザー別の読書記録管理
- 非公開 R2 による写真の保存と、所有者を確認する画像 API

### 読書記録の取得 API

いずれもログインが必要で、本人の記録だけを返します。

- `GET /api/books/home`：`totalCount`、日本時間の当年の読了日を持つ件数 `finishedThisYear`、登録日時順の最新5件 `books` を返します。
- `GET /api/books?page=3&limit=20`：指定ページの `books` と、`page`、`limit`、`totalCount`、`totalPages` を返します。ページは1始まり、`limit` は1〜20（省略時20）です。0件でも1ページとし、範囲外のページには `page_out_of_range` と現在の件数・ページ数を返します。
- パラメータなしの `GET /api/books` は既存画面向けの全件応答を維持します。

メール認証、パスワード再設定は未実装です。
