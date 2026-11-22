# キーボードショートカット

`Mod` は macOS では `Cmd`、それ以外では `Ctrl` です。input、textarea、select、contenteditable の要素にフォーカスがある間、ショートカットは無視されます。

> **レジストリ:** 以下のカスタマイズ可能なショートカットは、[`src/ui/settings/shortcuts.ts`](../../src/ui/settings/shortcuts.ts) のレジストリ（`SHORTCUT_ACTIONS`）で宣言しています。ユーザーによる上書きは、アクションごとに既定のキーを置き換えます。レジストリにアクションを追加・変更したときは、この表も更新してください。

## トランスポート

| Keys | Action | Scope |
| --- | --- | --- |
| `Space` | 再生 / 停止 <!-- shortcut-action: transport.togglePlayback --> | グローバル |
| `L` | 左右のロケーター間のループを切り替え <!-- shortcut-action: transport.toggleLoop --> | グローバル |
| `R` | 録音 <!-- shortcut-action: transport.toggleRecord --> | グローバル |
| `Home` | プロジェクトの先頭へ移動 <!-- shortcut-action: transport.toStart --> | グローバル |
| `End` | プロジェクトの末尾へ移動 <!-- shortcut-action: transport.toEnd --> | グローバル |
| `,` / `.` | 再生ヘッドを 1 小節戻す / 進める <!-- shortcut-action: transport.nudgeBack --> <!-- shortcut-action: transport.nudgeForward --> | グローバル |
| `[` / `]` | 再生ヘッド位置に左 / 右ロケーターを設定 <!-- shortcut-action: transport.setLeftLocator --> <!-- shortcut-action: transport.setRightLocator --> | グローバル |

## プロジェクト

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+S` | プロジェクトを保存（OPFS。自動保存スロットも更新） <!-- shortcut-action: project.save --> | グローバル |
| `Mod+Shift+S` | プロジェクトを別名で保存… <!-- shortcut-action: project.saveAs --> | グローバル |
| `Mod+O` | プロジェクトを開く <!-- shortcut-action: project.open --> | グローバル |

## 編集

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+Z` | 取り消し <!-- shortcut-action: edit.undo --> | グローバル |
| `Mod+Shift+Z` | やり直し <!-- shortcut-action: edit.redo --> | グローバル |
| `Mod+C` | 現在の選択範囲をコピー <!-- shortcut-action: edit.copy --> | グローバル |
| `Mod+X` | 現在の選択範囲をカット <!-- shortcut-action: edit.cut --> | グローバル |
| `Mod+V` | 再生ヘッド位置にペースト <!-- shortcut-action: edit.paste --> | グローバル |
| `Mod+A` | アクティブクリップのノートをすべて選択 <!-- shortcut-action: edit.selectAllNotes --> | グローバル |
| `Q` | 選択ノートをクオンタイズ <!-- shortcut-action: edit.quantizeSelection --> | グローバル |
| `Backspace` / `Delete` | 選択ノートを削除 <!-- shortcut-action: edit.deleteSelectedNotes --> | エディタードック |
| `Shift+ArrowUp` / `Shift+ArrowDown` | 選択ノートを半音上げる / 下げる <!-- shortcut-action: edit.transposeUp --> <!-- shortcut-action: edit.transposeDown --> | エディタードック |
| `Mod+Shift+ArrowUp` / `Mod+Shift+ArrowDown` | 選択ノートを 1 オクターブ上げる / 下げる <!-- shortcut-action: edit.transposeOctaveUp --> <!-- shortcut-action: edit.transposeOctaveDown --> | エディタードック |
| `Escape` | 進行中のドラッグ操作を取り消す（ピアノロール） | エディタードック |
| `[` / `]` | 選択ノートを 1 グリッド分短く / 長くする（ピアノロール）。フォーカス中のピアノロールでノートを選択している間は、グローバルのロケーター用ショートカットより優先されます | エディタードック |

## アレンジ

アレンジゾーンにフォーカスがあるとき（最後にポインターを押した場所）に動作します。

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+D` | アクティブクリップの直後に複製 <!-- shortcut-action: arrange.duplicateClip --> | アレンジ |
| `B` | 再生ヘッドでクリップを分割 <!-- shortcut-action: arrange.splitClipAtPlayhead --> | アレンジ |
| `Backspace` / `Delete` | アクティブクリップを削除 <!-- shortcut-action: arrange.deleteClip --> | アレンジ |

## トラック

アクティブなアレンジトラックに作用します。

| Keys | Action | Scope |
| --- | --- | --- |
| `Alt+M` | アクティブトラックのミュートを切り替え <!-- shortcut-action: track.toggleMute --> | アレンジ |
| `Alt+S` | アクティブトラックのソロを切り替え <!-- shortcut-action: track.toggleSolo --> | アレンジ |
| `Alt+A` | アクティブトラックの録音アームを切り替え <!-- shortcut-action: track.toggleArm --> | アレンジ |

## 表示

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+G` | スナップグリッドを切り替え <!-- shortcut-action: view.toggleSnap --> | グローバル |
| `Mod+E` | スコアパネルを切り替え（ドックはピアノロールに切り替わります） <!-- shortcut-action: view.toggleScorePanel --> | グローバル |
| `Mod+=` | 拡大 <!-- shortcut-action: view.zoomIn --> | グローバル |
| `Mod+-` | 縮小 <!-- shortcut-action: view.zoomOut --> | グローバル |
| `Mod+Shift+F` | 全体を表示 <!-- shortcut-action: view.zoomToFit --> | グローバル |

## スコア

スコアパネルにフォーカスがあるときに有効です。編集はいずれも、アクティブクリップに対する取り消し可能なコマンドです。

| Keys | Action | Scope |
| --- | --- | --- |
| `N` | 選択ノートの後ろに、同じ音高と長さのノートを追加 | スコア |
| ダブルクリック | クリックした位置にノートを挿入（選択ノートをコピー、なければ中央のド） | スコア |
| ノート上の縦ドラッグ | ドラッグ 1 段階ごとに音高を半音単位で変更 | スコア |
| `Backspace` / `Delete` | 選択ノートを削除（エディタードックのショートカット） | エディタードック |

## ツール

| Keys | Action | Scope |
| --- | --- | --- |
| `1` | 選択ツール <!-- shortcut-action: tool.select --> | グローバル |
| `2` | 描画ツール <!-- shortcut-action: tool.draw --> | グローバル |
| `3` | 分割ツール <!-- shortcut-action: tool.split --> | グローバル |
| `4` | 消去ツール <!-- shortcut-action: tool.erase --> | グローバル |

## アプリケーション

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+,` | 設定を開く <!-- shortcut-action: app.settings --> | グローバル |
| `Mod+K` | コマンドパレットを開く <!-- shortcut-action: app.commandPalette --> | グローバル |
| `?` | ショートカットヘルプを表示 <!-- shortcut-action: help.shortcuts --> | グローバル |

## ミュージックタイピング（固定、再割り当て不可）

エディターツールバーで「ミュージックタイピング」を有効にしている間だけ動作します。ウィンドウ全体が対象で、フォーカスが外れると解除されます。

| Keys | Action |
| --- | --- |
| `A W S E D F T G Y H U J K` | ノートを演奏（基準オクターブのドから上へ、白鍵と黒鍵が交互に並ぶ） |
| `Z` / `X` | オクターブを下げる / 上げる（−1〜9 に制限） |
| `C` / `V` | ベロシティを −10 / +10（1〜127 に制限） |
| `Tab` | 休符を挿入（ステップ入力が有効なときのみ） |

## ポインター操作

| Gesture | Action | Where |
| --- | --- | --- |
| `Mod+wheel` | ズーム | アレンジ、ピアノロール |
| `Shift+wheel` | 横スクロール | アレンジ、ピアノロール |
| ホイール | パン | アレンジ、ピアノロール |
| ダブルクリック | ノート / クリップを作成 | ピアノロール / アレンジのレーン |

## ダイアログとウィジェット

| Keys | Action | Where |
| --- | --- | --- |
| `Escape` | 閉じる / キャンセル | 新規プロジェクト、オーディオ書き出し、パッチエディターの各ダイアログ、ウェルカムツアー |
| `Enter` | 確定 / 作成 | 新規プロジェクトダイアログ、インラインの名前変更と値の入力欄 |
| `ArrowUp` / `ArrowDown` | テンプレートの選択を移動 | 新規プロジェクトダイアログ |
| `Escape`（レンダリング中） | 書き出しのレンダリングをキャンセル | オーディオ書き出しダイアログ |
| `ArrowUp/Right` / `ArrowDown/Left` | 増やす / 減らす（対応する箇所では `Shift` を押すと細かい刻み） | ミキサーのフェーダー、ノブ、クイックコントロール |
| `Enter` / `Escape` | セルの値を確定 / 元に戻す | テンポマップ、拍子、情報行のエディター |
| `Enter` / `Escape` | 名前変更を確定 / キャンセル | セクションレーン、トラックヘッダー |
| `Enter` / `ArrowRight`、`ArrowLeft`、`Escape` | 次へ、戻る、スキップ | ウェルカムツアーのツールチップ |
