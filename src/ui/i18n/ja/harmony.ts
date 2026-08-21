/** Chord and harmony vocabulary shared by the readouts. */
export const harmony = {
  cadence: {
    label: '終止形',
    authentic: '正格終止',
    plagal: '変格終止',
    half: '半終止',
    deceptive: '偽終止',
    short: {
      authentic: '正格',
      plagal: '変格',
      half: '半',
      deceptive: '偽',
    },
  },
  borrowed: {
    label: '借用和音',
    parallelMinor: '同主短調からの借用和音',
    parallelMajor: '同主長調からの借用和音',
    neapolitan: 'ナポリの和音',
  },
  applied: {
    label: '副属和音 {roman}',
  },
  modulation: {
    label: '転調',
    relation: {
      same: '同じ調へ',
      enharmonic: '異名同音調へ',
      relative: '平行調へ',
      parallel: '同主調へ',
      dominant: '属調へ',
      subdominant: '下属調へ',
      relativeOfDominant: '属調の平行調へ',
      relativeOfSubdominant: '下属調の平行調へ',
    },
    unnamedRelation: '名前のある関係にない調へ',
    pivot: '両方の調で読める {roman} で転回しています。',
    direct: '両方の調で読めるコードが無いため、直接転調です。',
    alternatives: '{romans} でも転回できました。',
  },
} as const;
