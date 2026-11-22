# はじめに

## 動作要件

- Chromium 系または Firefox 系の最近のブラウザ。AudioWorklet、WebAssembly、OPFS を使い、利用できる場合は SharedArrayBuffer も使います。
- **クロスオリジン分離**。開発サーバーとプレビューサーバー、および同梱の `public/_headers` が `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` を送ります。SharedArrayBuffer にはこれが必要です。分離されていない環境では、エンジンは postMessage 経由の通信に切り替わり、動作は続きます。
- ローカルで動かすには Node 24 と Yarn 4 が必要です。[mise](https://mise.jdx.dev) を使って `mise.toml` で固定しています。

## ローカルで動かす

```sh
yarn install
yarn dev
```

表示された URL を開きます。スタート画面では、新規プロジェクト、同梱デモ（トッカータとフーガ ニ短調 BWV 565）、ブラウザストレージにある既存のプロジェクトのいずれかを選べます。**Play** を押すと、オーディオエンジンが自動で起動します。

`yarn build` は本番ビルドを `dist/` に出力し、`yarn preview` は同じ分離ヘッダー付きでそれを配信します。ビルドを別の場所で配信する方法は、[デプロイ](deployment.md)のページにあります。

## スクリプト

| Script                          | Description                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `yarn dev`                      | クロスオリジン分離ヘッダー付きの Vite 開発サーバー                                               |
| `yarn build`                    | ワークレットバンドル、型チェック、本番ビルド。続けて、ビルドが導入済みのエンジンを含むことを確認 |
| `yarn build:worklet`            | 自己完結した AudioWorklet モジュールだけをビルド                                                 |
| `yarn preview`                  | 本番ビルドをローカルで配信                                                                       |
| `yarn test` · `yarn test:watch` | Vitest（jsdom）のユニット／コンポーネントテスト                                                  |
| `yarn test:coverage`            | 同じスイートを v8 カバレッジ付きで実行                                                           |
| `yarn test:external-formats`    | 書き出したファイルを外部ツールで検証                                                             |
| `yarn lint` · `yarn lint:fix`   | Biome のチェック／自動修正                                                                       |
| `yarn typecheck`                | `vue-tsc --noEmit`                                                                               |
| `yarn verify`                   | lint、スペックの型チェック、テスト、外部形式テスト、ビルド                                       |
| `yarn e2e`                      | 静的な本番ビルドに対するブラウザ E2E の実行                                                      |
| `yarn ci`                       | `verify` のあとに `e2e` を実行                                                                   |

テストの構成と E2E ハーネスは、[CONTRIBUTING.md](../../CONTRIBUTING.md)（英語のみ）で説明しています。
