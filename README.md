# book-list

読書記録アプリの Cloudflare Workers + React + Vite 構成です。

## 起動方法

```powershell
npm install
npm run dev
```

ローカル開発サーバーは Vite と Cloudflare Vite Plugin で起動します。

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

## 現在の実装範囲

- React + Vite のフロントエンド
- Cloudflare Workers の API エントリ
- Cloudflare Vite Plugin による同一プロジェクト構成
- `/api/health` による Worker API 疎通確認
- `/api/books` による将来の読書記録 API の仮エンドポイント

D1、認証、画像アップロードは未実装です。
