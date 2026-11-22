/** Error and status messages composables publish to the app banners. */
export const notices = {
  engineNotStarted: '先にエンジンを起動してください。',
  engineProcessorCrashed:
    'エンジンのワークレットプロセッサーが処理中にクラッシュしました (onprocessorerror)。',
  engineCleanupFailed: 'エンジンの後片付けで {count} 件の失敗がありました: {details}',
  musicXmlUnavailable: {
    'active-midi-clip-required': 'MusicXML で書き出すには MIDI クリップを選択してください。',
    'midi-track-required': 'スコアを MusicXML で書き出すには MIDI トラックを追加してください。',
    'score-window-required': 'MusicXML で書き出せるスコア範囲がプロジェクトにありません。',
    unknown: '現在 MusicXML を書き出せません。',
  },
  errors: {
    engineRejected: 'オーディオエンジンが操作を拒否しました (コード {code})。',
    memoryLimit: {
      'live-schedule':
        '再生に約 {required} MiB の作業メモリーが必要で、ブラウザーの上限 {budget} MiB を超えています。オーディオクリップを短くするか、一部を削除してください。',
      'audio-export':
        '書き出しに約 {required} MiB の作業メモリーが必要で、ブラウザーの上限 {budget} MiB を超えています。範囲を短くするか、サンプルレートを下げるか、ページ数を減らして書き出してください。',
      'audio-encoding':
        'エンコードに約 {required} MiB の作業メモリーが必要で、ブラウザーの上限 {budget} MiB を超えています。範囲を短くするか、サンプルレートを下げるか、ページ数を減らして書き出してください。',
      'score-export':
        '楽譜の書き出しに約 {required} MiB の作業メモリーが必要で、ブラウザーの上限 {budget} MiB を超えています。ページ数を減らすか、範囲を短くして書き出してください。',
      transcription:
        '採譜に約 {required} MiB の作業メモリーが必要で、ブラウザーの上限 {budget} MiB を超えています。オーディオの短い区間で採譜してください。',
    },
  },
  trackLaneOverflow:
    '{limit} トラックの上限を超えた {count} トラックにはミキサーのレーンがなく、音が出ません。トラックを削除して上限内に収めてください。',
  webMidiConnectFailed: 'Web MIDI に接続できませんでした: {detail}',
  upgradeDroppedSettings:
    '以前のバージョンで保存されたマスタリング設定 {count} 件を引き継げなかったため、プリセットの値を使います: {keys}。各設定と理由はブラウザのコンソールに出力しています。',
  gsSetupUnapplied:
    'GS/SysExのセットアップメッセージ {count} 件が再生用シンセに適用されませんでした。適用されるのは、曲頭で最初のノートより前にある {limit} バイト以内の完結したセットアップメッセージのみです。これらはMIDI書き出しでは保持されます。',
  recording: {
    engineNotStarted: '録音の前にエンジンを起動してください。',
    micDisconnected:
      'マイクが切断されました。デバイスを接続し直して、もう一度リクエストしてください。',
    inputProcessorCrashed:
      'ボイスチェンジャーまたはピッチ補正が異常終了したため停止しました。マイクを再リクエストすると再開できます。',
    armedTrackLocked: '録音中はアームしたトラックを変更できません。',
    unknownTrack: '不明なトラック ID: {id}',
    unknownSource: '不明な録音ソース: {source}',
    audioTrackRequired: '録音にはオーディオトラックが必要です。',
    midiTrackRequired: 'MIDI 録音には MIDI トラックが必要です。',
    armAudioTrack: '録音の前にオーディオトラックを録音アームにしてください。',
    armMidiTrack: '録音の前に MIDI トラックを録音アームにしてください。',
    voiceChangerNextBinding: 'ボイスチェンジャーの変更は次回のマイク接続から反映されます。',
    voiceChangerBusy: '録音処理中はボイスチェンジャーを変更できません。',
    retuneNextBinding: 'リチューンの変更は次回のマイク接続から反映されます。',
    retuneBusy: '録音処理中はリチューンを変更できません。',
    sourceNextTake: '録音ソースの変更は次のテイクから反映されます。',
    deviceNextTake: '入力デバイスの変更は次のテイクから反映されます。',
    multiDeviceEffectsUnavailable:
      '複数の録音デバイスではボイスチェンジャーとリチューンを使えません。単一デバイスまたはアグリゲートデバイスで録音してください。',
    punchOrder: 'パンチアウトのロケーターはパンチインより後に置いてください。',
    transportRejected: 'エンジンが再生コマンドを拒否しました。',
    inputChangedBeforeStop: 'テイクを停止する前に録音入力が変わりました。テイクは破棄されました。',
    inputChangedBeforeSave: 'テイクを保存する前に録音入力が変わりました。テイクは破棄されました。',
    emptyTake:
      'テイクに音声が録音されませんでした。入力レイテンシより長く録音するか、入力デバイスを確認してください。',
    overflow:
      '録音がキャプチャーバッファーの上限に達したため、テイクの終わりが切り捨てられました。',
    storeFailed: '録音を保存できませんでした: {detail}',
    storeFailedCleanup:
      '録音を保存できませんでした: {detail}。後片付けにも失敗しました: {cleanupDetail}',
  },
} as const;
