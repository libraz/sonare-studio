/** Theory explanations behind the guidance cards and the glossary. */
export const theory = {
  roles: {
    root: 'root',
    third: '3rd',
    fifth: '5th',
    sixth: '6th',
    seventh: '7th',
    tension: 'tension',
    doubling: 'doubling',
  },
  functions: {
    tonic: 'Tonic',
    subdominant: 'Subdominant',
    dominant: 'Dominant',
  },
  lines: {
    role: 'Role',
    chord: 'Chord',
    scale: 'Scale',
    note: 'Note',
    safety: 'Safety',
    chordScale: 'Color',
    counterpoint: 'Counterpoint',
  },
  intervalNames: {
    '0': 'unison',
    '1': 'minor 2nd',
    '2': 'major 2nd',
    '3': 'minor 3rd',
    '4': 'major 3rd',
    '5': 'perfect 4th',
    '6': 'tritone',
    '7': 'perfect 5th',
    '8': 'minor 6th',
    '9': 'major 6th',
    '10': 'minor 7th',
    '11': 'major 7th',
    '12': 'octave',
  },
  scaleNames: {
    major: 'Major',
    ionian: 'Ionian',
    naturalMinor: 'Natural minor',
    aeolian: 'Aeolian',
    harmonicMinor: 'Harmonic minor',
    melodicMinor: 'Melodic minor',
    dorian: 'Dorian',
    phrygian: 'Phrygian',
    lydian: 'Lydian',
    mixolydian: 'Mixolydian',
    locrian: 'Locrian',
    lydianDominant: 'Lydian dominant',
    mixolydianB13: 'Mixolydian ♭13',
    locrianNatural2: 'Locrian ♮2',
    altered: 'Altered',
    phrygianDominant: 'Phrygian dominant',
    majorPentatonic: 'Major pentatonic',
    minorPentatonic: 'Minor pentatonic',
    blues: 'Blues',
    wholeTone: 'Whole tone',
    octatonicHalfWhole: 'Octatonic (half-whole)',
    octatonicWholeHalf: 'Octatonic (whole-half)',
    chromatic: 'Chromatic',
  },
  inferred: 'inferred',
  levelName: {
    beginner: 'Beginner',
    normal: 'Normal',
    theory: 'Theory',
  },
  levels: {
    beginner: {
      lock: {
        identity: 'This note anchors the chord — best left where it is',
        quality: 'This note sets the chord’s bright or dark feel; moving it changes that',
        voicing: 'A flexible note — you can move it freely',
      },
      safety: {
        safe: 'Fits the chord — use it freely',
        warning: 'Works, but adds tension — use with care',
        dissonant: 'Clashes with the chord — it may sound off',
      },
      labels: {
        suspension: 'Leans on the chord, then steps down to settle',
        appoggiatura: 'Arrives with a leap and leans in, then steps away to settle',
        passing: 'Fills the gap between two chord notes as you pass through',
        neighbor: 'Steps away and comes right back — a little decoration',
        avoid: 'Tends to clash here — use it only in passing',
        tension: 'A colour note ({degree}) you can add on top of the chord',
        anticipation: 'Arrives early on the next chord’s note',
        escape: 'Steps away without settling — a light touch',
        needsResolution: 'Feels unfinished — let the next note settle it',
        leadingTone: 'Pulls strongly up to the home note',
      },
      scaleDegree: 'Note {degree}',
      nonScaleSuffix: ' — outside the scale',
      nonScaleTone: 'Outside the current scale',
      cadenceArrival: '{cadence} — the music comes to rest here',
      chordScale: {
        tensions: 'Colour notes you can add:',
        passing: 'Notes to pass through only:',
        avoid: 'Notes to handle with care:',
        alternates: 'also fits:',
      },
      counterpoint: {
        toBass: 'A {interval} above the lower note ({consonance})',
        consonance: {
          perfect: 'stable',
          imperfect: 'mellow',
          dissonant: 'clashing',
        },
        suspension: 'Holds over and clashes, then steps down to {target} to settle',
        suspensionNoTarget: 'Holds over and clashes, then steps down to settle',
        parallelPerfect: 'Runs parallel with the lower voice in the same open interval',
        hiddenParallel: 'Moves the same way into an open, perfect sound',
        battuta: 'Drops onto an octave while the other voice climbs to meet it',
        voiceCrossing: 'Dips below the voice beneath it',
        wideSpacing: 'Sits over an octave away from the voice next to it',
        forbiddenLeap: 'Jumps here from the note before by a step that is hard to sing',
        leadingToneResolution: 'The note before pulled up into this one and came home',
        unresolvedSuspension: 'Has not settled yet — stepping down to {expected} would settle it',
        unresolvedNonChordTone: 'Has not settled yet — moving on to {expected} would settle it',
        accompanimentThinned: 'Fits because {track} leaves out its {pitch}',
        against: '{verdict} — against {tracks}',
      },
    },
    normal: {
      lock: {
        identity: "Sets the chord's root",
        quality: 'Defines major/minor — moving it changes the quality',
        voicing: 'Free voicing tone',
      },
      safety: {
        safe: 'Fits here',
        warning: 'Use with care',
        dissonant: 'Clashes with the chord',
      },
      labels: {
        suspension: 'Suspension: resolve down by step',
        appoggiatura: 'Appoggiatura: arrives by leap, resolve by step',
        passing: 'Passing tone',
        neighbor: 'Neighbor tone',
        avoid: 'Avoid note here',
        tension: 'Usable {degree}th tension',
        anticipation: 'Anticipation: anticipates the next chord',
        escape: 'Escape tone',
        needsResolution: 'Needs resolution: resolve on the next note',
        leadingTone: 'Leading tone: resolves up to the tonic',
      },
      scaleDegree: 'Degree {degree}',
      nonScaleSuffix: ' (non-scale)',
      nonScaleTone: 'Non-scale tone',
      cadenceArrival: '{cadence} — the phrase closes here',
      chordScale: {
        tensions: 'tensions',
        passing: 'passing',
        avoid: 'avoid',
        alternates: 'or',
      },
      counterpoint: {
        toBass: '{interval} above the bass ({consonance})',
        consonance: {
          perfect: 'perfect consonance',
          imperfect: 'imperfect consonance',
          dissonant: 'dissonant',
        },
        suspension: 'Suspension — resolves by step to {target}',
        suspensionNoTarget: 'Suspension — resolves by step',
        parallelPerfect: 'Parallel perfect interval',
        hiddenParallel: 'Hidden perfect interval',
        battuta: 'Battuta — octave by contrary motion, upper voice leaping down',
        voiceCrossing: 'Voice crossing',
        wideSpacing: 'Wide spacing — over an octave to the neighbouring voice',
        forbiddenLeap: 'Forbidden melodic leap from the previous note',
        leadingToneResolution: 'Leading tone resolved up to the tonic here',
        unresolvedSuspension: 'Unresolved suspension (expected: {expected})',
        unresolvedNonChordTone: 'Unresolved non-chord tone (expected: {expected})',
        accompanimentThinned: 'Fits by thinning {pitch} in {track}',
        against: '{verdict} — against {tracks}',
      },
    },
    theory: {
      lock: {
        identity: 'Chord root (identity)',
        quality: 'Quality-defining tone (3rd)',
        voicing: 'Voicing tone (free)',
      },
      safety: {
        safe: 'Consonant / chord-scale tone',
        warning: 'Tension — conditional',
        dissonant: 'Dissonant against the chord',
      },
      labels: {
        suspension: 'Suspension — resolves stepwise down',
        appoggiatura: 'Appoggiatura (accented) — approached by leap, resolves stepwise',
        passing: 'Passing tone (stepwise, unaccented)',
        neighbor: 'Neighbor tone (upper/lower)',
        avoid: 'Avoid tone (half-step above a chord tone)',
        tension: 'Available tension: {degree}',
        anticipation: 'Anticipation of the next chord tone',
        escape: 'Escape tone (échappée)',
        needsResolution: 'Unresolved dissonance — resolve stepwise',
        leadingTone: 'Leading tone — resolves ↑ to tonic',
      },
      scaleDegree: 'Degree {degree}',
      nonScaleSuffix: ' (non-diatonic)',
      nonScaleTone: 'Non-diatonic tone',
      cadenceArrival: '{cadence} — phrase arrival',
      chordScale: {
        tensions: 'available tensions',
        passing: 'passing tones',
        avoid: 'avoid notes',
        alternates: 'or',
      },
      counterpoint: {
        toBass: '{interval} above the bass ({consonance})',
        consonance: {
          perfect: 'perfect consonance',
          imperfect: 'imperfect consonance',
          dissonant: 'dissonant',
        },
        suspension: 'Suspension — resolves stepwise down to {target}',
        suspensionNoTarget: 'Suspension — resolves stepwise down',
        parallelPerfect: 'Parallel perfect 5th/8ve',
        hiddenParallel: 'Hidden (direct) perfect interval',
        battuta: 'Ottava battuta — perfect 8ve/unison by contrary motion, upper voice leaping ↓',
        voiceCrossing: 'Voice crossing',
        wideSpacing: 'Spacing — over an 8ve between adjacent upper voices',
        forbiddenLeap: 'Forbidden melodic leap — 7th, augmented/diminished, or over an 8ve',
        leadingToneResolution: 'Leading tone resolved ↑ to the tonic',
        unresolvedSuspension: 'Suspension left unresolved (expected {expected})',
        unresolvedNonChordTone: 'Passing or neighbour tone left unresolved (expected {expected})',
        accompanimentThinned: 'Consonant by thinning {pitch} in {track} (lead following)',
        against: '{verdict} — against {tracks}',
      },
    },
  },
  glossary: {
    suspension: {
      term: 'Suspension',
      definition:
        'A note held over from the previous chord that clashes, then resolves down by step to a chord tone.',
    },
    appoggiatura: {
      term: 'Appoggiatura',
      definition:
        'A note leant on at the start of a beat, reached by a leap and left by a step to a chord tone; unlike a suspension it is not held over from the previous chord.',
    },
    passing: {
      term: 'Passing tone',
      definition:
        'A note that fills the gap between two chord tones by stepping through, off the beat.',
    },
    neighbor: {
      term: 'Neighbor tone',
      definition: 'A note a step above or below a chord tone that steps away and returns to it.',
    },
    avoid: {
      term: 'Avoid note',
      definition:
        'A scale note that clashes against the chord, usually a half-step above a chord tone. It is left out altogether rather than moved through; the note you may move through is the passing tone.',
    },
    tension: {
      term: 'Tension',
      definition:
        'A colour note added above the basic chord (the 9th, 11th or 13th) that enriches its sound.',
    },
    chordScale: {
      term: 'Chord scale',
      definition:
        'The scale that fits over the chord sounding underneath: the notes at home on it, plus the colour notes it invites.',
    },
    anticipation: {
      term: 'Anticipation',
      definition: 'A note of the next chord sounded early, before that chord actually arrives.',
    },
    escape: {
      term: 'Escape tone',
      definition:
        'A note approached by step and left by a leap in the opposite direction, without resolving.',
    },
    needsResolution: {
      term: 'Unresolved tone',
      definition: 'A dissonant note that sounds unfinished until the next note settles it by step.',
    },
    leadingTone: {
      term: 'Leading tone',
      definition:
        'The seventh scale degree, a half-step below the tonic, which pulls strongly up to it.',
    },
    parallelPerfect: {
      term: 'Parallel perfect interval',
      definition:
        'Two voices moving in the same direction while holding a perfect 5th or octave. It erases their independence, so classical style avoids it.',
    },
    hiddenParallel: {
      term: 'Hidden perfect interval',
      definition:
        'Two voices moving in the same direction into a perfect 5th or octave (a direct fifth/octave); disliked especially between the outer voices.',
    },
    battuta: {
      term: 'Ottava battuta',
      definition:
        'An octave or unison arrived at by contrary motion with the upper voice leaping down onto it. The two parts collapse onto the same open sound from opposite sides, which sixteenth-century writing avoids; the same octave reached by step, or with the upper voice rising, is fine.',
    },
    voiceCrossing: {
      term: 'Voice crossing',
      definition:
        'When a voice dips below the one beneath it (or rises above the one atop it), making the parts harder to follow.',
    },
    wideSpacing: {
      term: 'Spacing',
      definition:
        'How far apart neighbouring voices sit. Upper voices are conventionally kept within an octave of each other so the sound holds together; the bass is exempt and may stand any distance below the voice above it.',
    },
    forbiddenLeap: {
      term: 'Forbidden melodic leap',
      definition:
        'A melodic leap strict counterpoint rules out as unsingable: a seventh, any augmented or diminished interval — the augmented second of the harmonic minor among them — or a leap wider than an octave.',
    },
    leadingToneResolution: {
      term: 'Leading-tone resolution',
      definition:
        'The seventh degree stepping up to the tonic it pulls towards. This is what the leading tone is named for, so it is an observation rather than a fault.',
    },
    tonic: {
      term: 'Tonic',
      definition: 'The home chord built on the first scale degree; it sounds settled and at rest.',
    },
    subdominant: {
      term: 'Subdominant',
      definition:
        'A chord (often on the fourth degree) that moves away from home and sets up the dominant.',
    },
    dominant: {
      term: 'Dominant',
      definition: 'The chord on the fifth degree; its tension pulls strongly back to the tonic.',
    },
  },
} as const;
