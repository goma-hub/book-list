# book-list

読書記録アプリの Cloudflare Workers + React + Vite 構成です。

## 起動方法

```powershell
npm install
npm run dev
```

ローカル開発サーバーは Vite と Cloudflare Vite Plugin で起動します。

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
