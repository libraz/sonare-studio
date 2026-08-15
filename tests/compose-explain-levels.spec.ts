import { NAMED_SCALES } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { GLOSSARY_KEY_FOR_KIND, theoryLabelsFor } from '@/compose/explain';
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
        const labels = theoryLabelsFor(MESSAGES[locale].theory, level);

        for (const value of Object.values(labels.lock)) expect(value.length).toBeGreaterThan(0);
        for (const value of Object.values(labels.safety)) expect(value.length).toBeGreaterThan(0);
        for (const kind of LABEL_KINDS) {
          expect(labels.labels[kind]?.length ?? 0).toBeGreaterThan(0);
        }
        expect(labels.scaleDegree).toContain('{degree}');
        expect(labels.nonScaleTone.length).toBeGreaterThan(0);
        expect(labels.chordScale.tensions.length).toBeGreaterThan(0);
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

  it('falls back to the normal level for an unknown level key', () => {
    const fallback = theoryLabelsFor(MESSAGES.en.theory, 'nonexistent');
    const normal = theoryLabelsFor(MESSAGES.en.theory, 'normal');
    expect(fallback.safety).toEqual(normal.safety);
  });
});
