/** Chord and harmony vocabulary shared by the readouts. */
export const harmony = {
  cadence: {
    label: 'Cadence',
    authentic: 'Authentic cadence',
    plagal: 'Plagal cadence',
    half: 'Half cadence',
    deceptive: 'Deceptive cadence',
    short: {
      authentic: 'auth',
      plagal: 'plag',
      half: 'half',
      deceptive: 'dec',
    },
  },
  borrowed: {
    label: 'Borrowed chord',
    parallelMinor: 'Borrowed from the parallel minor',
    parallelMajor: 'Borrowed from the parallel major',
    neapolitan: 'Neapolitan chord',
  },
  applied: {
    label: 'Applied dominant {roman}',
  },
  modulation: {
    label: 'Modulation',
    relation: {
      same: 'to the same key',
      enharmonic: 'to the enharmonic key',
      relative: 'to the relative key',
      parallel: 'to the parallel key',
      dominant: 'to the dominant',
      subdominant: 'to the subdominant',
      relativeOfDominant: 'to the relative of the dominant',
      relativeOfSubdominant: 'to the relative of the subdominant',
    },
    unnamedRelation: 'to a key it stands in no named relation to',
    pivot: 'Turns on {roman}, which reads in both keys.',
    direct: 'No chord reads in both keys, so the move is direct.',
    alternatives: 'Could also have turned on {romans}.',
  },
} as const;
