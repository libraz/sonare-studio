import { NAMED_SCALES, ReasonFlag } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import {
  buildTheoryCard,
  GLOSSARY_KEY_FOR_KIND,
  type TheoryCardLine,
  theoryLabelsFor,
} from '@/compose/explain';
import type { NoteAnalysis } from '@/compose/guidance';
import { MESSAGES } from '@/ui/i18n';

/**
 * Coverage guard for the explanation-level wording table. Every explanation
 * level, in every locale, must carry non-empty wording for the full theory
 * vocabulary, every scale the chord-scale report can name must have a display
 * name, and every glossary term the card can reference must exist. A gap here
 * means a note card would render a blank line, a raw library name, or a missing
 * definition.
 */

const LOCALES = ['en', 'ja'] as const;
const LEVELS = ['beginner', 'normal', 'theory'] as const;

/** Label kinds that carry card wording (every kind except plain chord tones). */
const LABEL_KINDS = Object.entries(GLOSSARY_KEY_FOR_KIND)
  .filter(([, key]) => key !== undefined)
  .map(([kind]) => kind) as ReadonlyArray<
  keyof (typeof MESSAGES)['en']['theory']['levels']['normal']['labels']
>;

/**
 * Glossary keys the card resolves: the labelled kinds, the chord-scale line's
 * term, and the three functions.
 */
const GLOSSARY_KEYS = [
  ...new Set([...Object.values(GLOSSARY_KEY_FOR_KIND).filter((k): k is string => k !== undefined)]),
  'chordScale',
  'tonic',
  'subdominant',
  'dominant',
];

describe('explanation-level wording', () => {
  for (const locale of LOCALES) {
    for (const level of LEVELS) {
      it(`${locale}/${level} carries non-empty wording for the whole vocabulary`, () => {
        const labels = theoryLabelsFor(
          MESSAGES[locale].theory,
          level,
          MESSAGES[locale].harmony.cadence,
        );

        for (const value of Object.values(labels.lock)) expect(value.length).toBeGreaterThan(0);
        for (const value of Object.values(labels.safety)) expect(value.length).toBeGreaterThan(0);
        for (const kind of LABEL_KINDS) {
          expect(labels.labels[kind]?.length ?? 0).toBeGreaterThan(0);
        }
        expect(labels.scaleDegree).toContain('{degree}');
        expect(labels.cadenceArrival).toContain('{cadence}');
        expect(labels.nonScaleTone.length).toBeGreaterThan(0);
        expect(labels.chordScale.tensions.length).toBeGreaterThan(0);
        expect(labels.chordScale.passing.length).toBeGreaterThan(0);
        expect(labels.chordScale.avoid.length).toBeGreaterThan(0);
        expect(labels.chordScale.alternates.length).toBeGreaterThan(0);
      });
    }

    it(`${locale} names every scale the chord-scale report can return`, () => {
      const { scaleNames } = MESSAGES[locale].theory;
      for (const name of Object.keys(NAMED_SCALES)) {
        expect(scaleNames[name as keyof typeof scaleNames], `scaleNames.${name}`).toBeTruthy();
      }
    });

    it(`${locale} defines every glossary term the card can reference`, () => {
      const { glossary } = MESSAGES[locale].theory;
      for (const key of GLOSSARY_KEYS) {
        expect(glossary[key], `glossary.${key}`).toBeDefined();
        expect(glossary[key].term.length).toBeGreaterThan(0);
        expect(glossary[key].definition.length).toBeGreaterThan(0);
      }
    });
  }

  /** Label of the counterpoint line, per locale. */
  const COUNTERPOINT_LABEL: Readonly<Record<(typeof LOCALES)[number], string>> = {
    en: 'Counterpoint',
    ja: '対位法',
  };

  /** The counterpoint verdict expected for a suspension with no known target. */
  const WITHOUT_TARGET: Readonly<
    Record<(typeof LOCALES)[number], Record<(typeof LEVELS)[number], string>>
  > = {
    en: {
      beginner: 'Holds over and clashes, then steps down to settle',
      normal: 'Suspension — resolves by step',
      theory: 'Suspension — resolves stepwise down',
    },
    ja: {
      beginner: '前の音を保ってぶつかり、一歩下がって収まります',
      normal: '掛留 — 順次解決',
      theory: '掛留（サスペンション）— 順次下行',
    },
  };

  /** The same verdict once a resolution pitch (B4) is known. */
  const WITH_TARGET: Readonly<
    Record<(typeof LOCALES)[number], Record<(typeof LEVELS)[number], string>>
  > = {
    en: {
      beginner: 'Holds over and clashes, then steps down to B4 to settle',
      normal: 'Suspension — resolves by step to B4',
      theory: 'Suspension — resolves stepwise down to B4',
    },
    ja: {
      beginner: '前の音を保ってぶつかり、B4 へ下がって収まります',
      normal: '掛留 — B4 へ順次解決',
      theory: '掛留（サスペンション）— B4 へ順次下行',
    },
  };

  function suspensionVerdict(
    locale: (typeof LOCALES)[number],
    level: (typeof LEVELS)[number],
    resolveTo?: number,
  ): TheoryCardLine | undefined {
    const analysis = {
      degree: 1,
      isScaleTone: true,
      chordSounding: false,
      safety: {
        reasons: ReasonFlag.Suspension,
        ...(resolveTo !== undefined ? { resolveTo } : {}),
      },
    } as NoteAnalysis;
    const card = buildTheoryCard(
      analysis,
      { pitch: 72, keySet: true },
      theoryLabelsFor(MESSAGES[locale].theory, level, MESSAGES[locale].harmony.cadence),
    );
    return card.lines.find((line) => line.label === COUNTERPOINT_LABEL[locale]);
  }

  for (const locale of LOCALES) {
    for (const level of LEVELS) {
      it(`${locale}/${level} states a suspension's resolution without naming an unknown pitch`, () => {
        // A suspension found in the voices alone carries no resolution target,
        // so substituting one into the templated wording would leave the
        // sentence hanging on a preposition (or, in Japanese, a particle).
        const line = suspensionVerdict(locale, level);
        const text = line?.text ?? '';
        expect(text).toBe(WITHOUT_TARGET[locale][level]);
        expect(text).not.toContain('{target}');
        expect(text).not.toMatch(/(?:\bto|へ|に)\s*$/);
        expect(text).not.toMatch(/\s{2,}/);
        expect(line?.term).toBe(MESSAGES[locale].theory.glossary.suspension);
      });

      it(`${locale}/${level} names the resolution pitch when the analysis carries one`, () => {
        const line = suspensionVerdict(locale, level, 71);
        expect(line?.text).toBe(WITH_TARGET[locale][level]);
        expect(line?.term).toBe(MESSAGES[locale].theory.glossary.suspension);
      });
    }
  }

  /** Card lines for a note carrying the resolution and thinning readings. */
  function trackingLines(
    locale: (typeof LOCALES)[number],
    level: (typeof LEVELS)[number],
    extra: Partial<NoteAnalysis>,
  ): TheoryCardLine[] {
    const analysis = { degree: 4, isScaleTone: true, chordSounding: false, ...extra };
    return buildTheoryCard(
      analysis,
      { pitch: 65, keySet: true, trackName: (id) => (id === 2 ? 'Backing' : undefined) },
      theoryLabelsFor(MESSAGES[locale].theory, level, MESSAGES[locale].harmony.cadence),
    ).lines;
  }

  const UNRESOLVED_SUSPENSION = {
    pendingResolution: { kind: 'suspension', expected: [64], next: 67, resolved: false },
  } as const satisfies Partial<NoteAnalysis>;
  const UNRESOLVED_PASSING = {
    pendingResolution: { kind: 'nonChordTone', expected: [67, 64], next: 62, resolved: false },
  } as const satisfies Partial<NoteAnalysis>;
  const THINNED = {
    thinnedAccompaniment: [{ trackId: 2, pitch: 64 }],
  } as const satisfies Partial<NoteAnalysis>;

  it('words an unresolved suspension and a thinned accompaniment note as the design states', () => {
    const texts = (extra: Partial<NoteAnalysis>) =>
      trackingLines('ja', 'normal', extra).map((line) => line.text);
    expect(texts(UNRESOLVED_SUSPENSION)).toContain('未解決の掛留（期待: E4）');
    expect(texts(THINNED)).toContain('Backing の E4 を間引いて成立');
  });

  for (const locale of LOCALES) {
    for (const level of LEVELS) {
      it(`${locale}/${level} names the expected pitches of an unresolved note`, () => {
        const suspension = trackingLines(locale, level, UNRESOLVED_SUSPENSION).find((line) =>
          line.text.includes('E4'),
        );
        expect(suspension?.label).toBe(COUNTERPOINT_LABEL[locale]);
        expect(suspension?.text).not.toMatch(/\{\w+\}/);
        expect(suspension?.term).toBe(MESSAGES[locale].theory.glossary.suspension);

        const passing = trackingLines(locale, level, UNRESOLVED_PASSING).find(
          (line) => line.text.includes('G4') && line.text.includes('E4'),
        );
        expect(passing?.label).toBe(COUNTERPOINT_LABEL[locale]);
        expect(passing?.text).not.toMatch(/\{\w+\}/);
        expect(passing?.term).toBe(MESSAGES[locale].theory.glossary.needsResolution);
      });

      it(`${locale}/${level} names the track a parallel was raised against`, () => {
        const parallel = trackingLines(locale, level, {
          safety: { safety: 1, reasons: ReasonFlag.ParallelPerfect },
          partners: [{ trackId: 2, reasons: ReasonFlag.ParallelPerfect }],
        }).find((line) => line.text.includes('Backing'));
        expect(parallel?.label).toBe(COUNTERPOINT_LABEL[locale]);
        expect(parallel?.text).not.toMatch(/\{\w+\}/);
        expect(parallel?.term).toBe(MESSAGES[locale].theory.glossary.parallelPerfect);
      });

      it(`${locale}/${level} names the track and pitch an accompaniment thinned`, () => {
        const thinned = trackingLines(locale, level, THINNED).find((line) =>
          line.text.includes('Backing'),
        );
        expect(thinned?.text).toContain('E4');
        expect(thinned?.text).not.toMatch(/\{\w+\}/);
      });
    }
  }

  it('says nothing about resolution once the note resolved or while it waits', () => {
    for (const resolved of [true, undefined]) {
      const lines = trackingLines('en', 'normal', {
        pendingResolution: { kind: 'suspension', expected: [64], resolved },
      });
      expect(lines.some((line) => line.text.includes('E4'))).toBe(false);
    }
  });

  it('falls back to the normal level for an unknown level key', () => {
    const fallback = theoryLabelsFor(
      MESSAGES.en.theory,
      'nonexistent',
      MESSAGES.en.harmony.cadence,
    );
    const normal = theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence);
    expect(fallback.safety).toEqual(normal.safety);
  });
});
