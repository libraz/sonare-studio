# sonare studio

[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](https://github.com/libraz/sonare-studio/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vue](https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Platform](https://img.shields.io/badge/platform-browser%20%7C%20WebAssembly-lightgrey)](https://github.com/libraz/sonare-studio)

**sonare studio は、ブラウザの中だけで動き、何もアップロードしない DAW です。** アレンジ、ピアノロール、ミキサー、マスタリング、浄書した譜面、理論に基づく作曲のすべてが、WebAssembly のオーディオエンジンでタブの中で動きます。プロジェクトは、普通のファイルとして書き出すまで、ブラウザ自身のストレージに置かれます。

🎧 **[アプリを開く](https://sonare-studio.libraz.net)** &nbsp;·&nbsp; 📖 **[ドキュメント](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md)** &nbsp;·&nbsp; **[はじめに](https://github.com/libraz/sonare-studio/blob/main/docs/ja/getting-started.md)** &nbsp;·&nbsp; **[キーボードショートカット](https://github.com/libraz/sonare-studio/blob/main/docs/ja/shortcuts.md)**

> 1.0 前の実験的なソフトウェアで、無保証です。`.szd` プロジェクト形式はリリース間で変わることがあり、コードは第三者による監査を受けていません。

![シェルの模式図。メニューバー、アレンジとその下のタブ式エディタードック、隣のデバイスラック、最下段のトランスポートバー](docs/images/shell-layout.svg)

## できること

- **アレンジ** — セクション、マーカー、コードレーン、テンポ／拍子マップ、ワープ、フリーズを備えた、マルチトラックの MIDI／オーディオタイムライン。[できること](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md#できること)
- **ノートを編集する** — コントローラーレーン、装飾、MIDI FX、エクスプレッションマップ、グルーヴ、ステップ入力、ステップシーケンサーを備えたピアノロール。[できること](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md#できること)
- **音を鳴らす** — 内蔵シンセ、GM/GS 音色とドラムキット、SoundFont（SF2）再生、マルチティンバー構成。[できること](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md#できること)
- **ミックスとマスタリング** — インサート、センド、オートメーション、メーターを備えたチャンネル／バス／VCA ストリップと、ラウドネスターゲット付きのマスタリングチェイン。[できること](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md#できること)
- **譜面を読む** — アクティブクリップを Verovio で浄書し、コードシンボル、印刷、PDF に対応。MusicXML と `.mxl` の読み書きはアプリ自身の記譜レイヤーが担います。[アーキテクチャ](https://github.com/libraz/sonare-studio/blob/main/docs/ja/architecture.md#譜面は導出物で入力手段ではない)
- **作曲する** — 1 つの再現可能なシードから生成するコード進行とパート、リハーモナイズ、ノートごとの理論ガイダンス。[できること](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md#できること)
- **録音してオーディオを解析する** — テイクとコンピング、テンポ／コード／セクションの解析、オーディオから MIDI への採譜、ステム分離。[できること](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md#できること)
- **ファイルを出し入れする** — `.szd`、DAWproject、Standard MIDI File、MIDI 2.0 クリップ、MusicXML、ステム、WAV / FLAC / MP3 のミックスダウン。[できること](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md#できること)
- **オフラインで使う** — インストール可能な PWA、英語と日本語の UI、再割り当て可能なショートカット、自動保存と名前付きリビジョン。[キーボードショートカット](https://github.com/libraz/sonare-studio/blob/main/docs/ja/shortcuts.md)

## はじめに

[sonare-studio.libraz.net](https://sonare-studio.libraz.net) でこのリポジトリのビルドを公開しているので、インストールせずに使えます。そこで開いたファイルはどこにもアップロードされません。アプリの実行には、最近の Chromium 系または Firefox 系のブラウザが必要です。ローカルで動かすには、Node 26 と Yarn 4（`mise.toml` で固定）が必要です。

```sh
yarn install
yarn dev      # dev server with cross-origin-isolation headers; open the printed URL
yarn build    # production build into dist/
```

スタート画面では、新規プロジェクトか同梱デモを選べます。**Play** を押すと、オーディオエンジンが自動で起動します。ビルドの配信方法は[デプロイ](https://github.com/libraz/sonare-studio/blob/main/docs/ja/deployment.md)にあります。

## 関連プロジェクト

- **[libsonare](https://github.com/libraz/libsonare)** — このアプリが動作の土台とする、WebAssembly にコンパイルした C++17 のオーディオエンジン。プロジェクトモデル、DSP、マスタリング、解析、オフラインレンダリングを担当します。[ドキュメント](https://libsonare.libraz.net)
- **[libsonare-mcp](https://github.com/libraz/libsonare-mcp)** — AI アシスタントが libsonare を通じて、オーディオと MIDI の解析、編集、マスタリング、ミックス、作曲を行うための MCP サーバー。
- **[libcantus](https://github.com/libraz/libcantus)** — 作曲機能とガイダンス機能を支える TypeScript の音楽理論ライブラリ。

## ドキュメント

ドキュメントは [`docs/`](https://github.com/libraz/sonare-studio/tree/main/docs) 以下の Markdown で、英語版と日本語版があります。

- **学ぶ** — [概要](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md) · [はじめに](https://github.com/libraz/sonare-studio/blob/main/docs/ja/getting-started.md)
- **ガイド** — [キーボードショートカット](https://github.com/libraz/sonare-studio/blob/main/docs/ja/shortcuts.md) · [デプロイ](https://github.com/libraz/sonare-studio/blob/main/docs/ja/deployment.md)
- **リファレンス** — [アーキテクチャ](https://github.com/libraz/sonare-studio/blob/main/docs/ja/architecture.md) · [Contributing](https://github.com/libraz/sonare-studio/blob/main/CONTRIBUTING.md)（英語のみ）

## 含まないもの（Non-goals）

MPE、プラグインのホスト（VST/AU/CLAP）、譜面上の少数のノート操作を超える記譜エディター、アカウント、同期、共同編集は対象外です。DAWproject と MusicXML の往復は、それらの形式の性質上、不可逆です。アプリは、書き出しで失われる内容を、確定する前に一覧で示します。[できないこと](https://github.com/libraz/sonare-studio/blob/main/docs/ja/introduction.md#できないこと)

## ライセンス

[AGPL-3.0-or-later](LICENSE)
