# デプロイ

アプリは静的サイトですが、クロスオリジン分離した状態で配信する必要があります。`yarn build` が `dist/` に出力します。以下のヘッダーとリダイレクトは、Cloudflare Pages 形式で `public/` に同梱しています。

## ヘッダーとルーティング

- `public/_headers` は、全パスに `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Embedder-Policy: require-corp`、`Cross-Origin-Resource-Policy: cross-origin` を設定し、あわせて `application/wasm` の Content-Type も設定します。`public/_redirects` は、すべてのパスを `index.html` へ振り分けます。
- `require-corp` のため、**アセットはすべて same-origin でなければなりません**。CDN のスクリプトもクロスオリジンのフォントも使えません。
- キャッチオールの rewrite があるので、現在のデプロイが配信しなくなったパスは `404` ではなく `200 text/html` を返します。Service Worker は、ドキュメント以外の URL に対するドキュメントを古いアセットとして扱います。プリキャッシュを拒否し、リリースキャッシュにも入れず、`404` を返します。これにより、アプリは解析できないスクリプトで失敗する代わりに、リロードを促せます。

## キャッシュと Service Worker

- `_headers` は、リリースモデルが前提とするキャッシュの取り決めも固定します。`/assets/*` は immutable です。`sw.js`、`precache-manifest.json`、`worklet-manifest.json`、および `/` と `/index.html` の両方のドキュメントは、リクエストのたびに再検証します。そのため、Worker が別リリースのマニフェストやドキュメントと組み合わさることはありません。
- Service Worker は `/` を正規のドキュメントとして使います。Cloudflare Pages は `/index.html` を `/` にリダイレクトするので、追従した応答は、ブラウザのナビゲーションに返す前に再構築する必要があります。インストール時には、古いアプリキャッシュに残ったリダイレクト済みドキュメントも修復します。Worker のテンプレートは、リリースキャッシュの識別子に含まれます。
- すでにインストール済みの壊れた Worker は、置き換えがインストールされる前の再訪ナビゲーションに失敗することがあります。置き換え後の Worker は、保存済みのプロジェクトを削除せずにキャッシュを修復し、以降の通常のナビゲーションで復旧できます。ドキュメントの読み込み前に起きる失敗は、ドキュメント内の復旧スクリプトでは扱えません。

## ファイルサイズ

デプロイするファイルは、Cloudflare Pages の 1 ファイルあたりの上限である 25 MiB 未満に保ってください。最大の成果物は、同梱の Verovio 浄書ワーカーと `sonare.wasm` で、いずれも数 MiB です。
