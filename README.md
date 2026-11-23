# 読書記録アプリ（book-list）

読んだ本の情報や感想を記録し、あとから振り返るためのWebアプリです。タイトル・作者名・読了日・メモ・写真を必要な項目だけ登録でき、ログインしたユーザーごとに記録を管理します。

**公開アプリ：** https://book-list.goma-lab.workers.dev

## 主な機能

- 読書記録の登録・一覧表示・詳細表示・編集・削除
- 登録冊数、今年の読了数、最近登録した5冊をホーム画面に表示
- 全件一覧を20冊ずつ表示し、ページ番号から移動
- 読了日は「年」「年月」「年月日」で入力可能。カレンダー選択にも対応
- 写真のアップロード・URL指定・削除。アップロード画像は必要に応じて自動縮小・圧縮
- メールアドレスとパスワードによるユーザー認証

「今年の読了数」は読了日の年を優先し、読了日が未入力の場合は登録日の日本時間で判定します。

## 使用技術

| 分野 | 技術 |
| --- | --- |
| フロントエンド | React、TypeScript、Vite |
| API・ホスティング | Cloudflare Workers、Cloudflare Vite Plugin |
| データベース | Cloudflare D1 |
| 画像保存 | Cloudflare R2 |
| 認証 | Better Auth |

## 工夫した点

- 読了日が曖昧な本も記録できるよう、日付の入力精度を選べる形式にしました。
- 写真変更・削除時の確認や、画面の配置が動かないトースト通知で誤操作を減らしています。
- 画像をブラウザ側で縮小・圧縮し、アップロードの手間と保存容量を抑えています。
- 認証・所有者確認、ログイン試行回数の制限、リクエスト容量の制限を設けています。

## ローカルでの起動

Node.js と npm を使用します。

```powershell
npm install
```

プロジェクト直下に、Git管理対象外の `.dev.vars` を作成します。

```dotenv
BETTER_AUTH_SECRET="32文字以上のランダムな値"
BETTER_AUTH_URL="http://localhost:5173"
```

`BETTER_AUTH_SECRET` には実際に生成したランダムな値を設定してください。上記は設定例であり、実際の秘密情報ではありません。

```powershell
npx wrangler d1 migrations list book-list-db --local
npx wrangler d1 migrations apply book-list-db --local
npm run dev
```

ローカル環境ではD1・R2のローカル保存領域を使用します。マイグレーションには既存テーブルを変更・削除するものが含まれるため、既存データがある環境ではSQLの内容を確認してから適用してください。

## 設計資料

- [システム要件書](docs/system-requirements.md)
- [画面設計書](docs/screen-design.md)

詳細な画面仕様や機能要件は、上記の設計書に記載しています。
