/**
 * Telling a song's repeated parts apart by their harmony.
 *
 * The audio section detector types each section (Intro, Verse, Chorus …) but
 * reuses a type across parts that share nothing musically, so a type ordinal
 * cannot say which sections are the same music. Comparing the sections' own
 * chroma can. This module owns that comparison; placing the sections on the
 * timeline lives in audio-sections.ts.
 *
 * Nothing here depends on the project model, so the thresholds can be driven
 * against the real feature extractor directly.
 */

/** A chroma feature matrix, row-major `[nChroma][nFrames]`. */
export interface ChromaFeatures {
  nChroma: number;
  nFrames: number;
  features: Float32Array;
}

/**
 * STFT window and hop for the comparison.
 *
 * The STFT chroma is what this needs, not the CQT ones: measured over a whole
 * song it is around 25 times cheaper (57 ms against 1.5 s for four minutes) and
 * separates repeats just as cleanly.
 */
export const SECTION_CHROMA_FFT = 4096;
export const SECTION_CHROMA_HOP = 2048;

/**
 * Cosine similarity above which two sections count as the same music.
 *
 * Measured on eight-second parts: a repeat survives an octave doubling, a level
 * change, a busier beat, an added top line and added noise, scoring 0.872 at
 * worst and 1.000 when unchanged, while different chord sets score 0.165 to
 * 0.691. The threshold sits in the empty band between them, far enough from
 * both ends that neither the arrangement changes nor the chord differences
 * measured here come near it. Chroma folds octaves away but not transposition,
 * so a part repeated in another key reads as a different section.
 */
export const SECTION_REPEAT_SIMILARITY = 0.8;

/**
 * Average chroma vector of one frame span, unit-normalized.
 *
 * @returns The vector, or null when the span is empty or silent and so cannot
 *   be compared with anything.
 */
export function sectionChromaVector(
  chroma: ChromaFeatures,
  fromFrame: number,
  toFrame: number,
): Float64Array | null {
  const from = Math.max(0, Math.min(chroma.nFrames, Math.floor(fromFrame)));
  const to = Math.max(from, Math.min(chroma.nFrames, Math.ceil(toFrame)));
  if (to <= from || chroma.nChroma <= 0) return null;
  const vector = new Float64Array(chroma.nChroma);
  for (let frame = from; frame < to; frame += 1) {
    for (let bin = 0; bin < chroma.nChroma; bin += 1) {
      vector[bin] += chroma.features[bin * chroma.nFrames + frame];
    }
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (!(norm > 0)) return null;
  norm = Math.sqrt(norm);
  for (let bin = 0; bin < vector.length; bin += 1) vector[bin] /= norm;
  return vector;
}

/** Cosine similarity of two unit vectors. */
function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) dot += a[i] * b[i];
  return dot;
}

/**
 * Groups sections whose chroma matches, so every repeat of one part shares a
 * group index.
 *
 * A section joins a group only when it matches *every* member. Matching any one
 * member would let a part that sits between two others chain them into a single
 * group. Sections with no comparable audio get a group to themselves, which
 * nothing else can join.
 *
 * @param vectors One unit chroma vector per section, in order (null when the
 *   section has no comparable audio).
 * @returns One group index per section.
 */
export function groupSectionRepeats(
  vectors: ReadonlyArray<Float64Array | null>,
  threshold = SECTION_REPEAT_SIMILARITY,
): number[] {
  const groups: Array<Float64Array[]> = [];
  return vectors.map((vector) => {
    if (!vector) {
      groups.push([]);
      return groups.length - 1;
    }
    const found = groups.findIndex(
      (members) =>
        members.length > 0 && members.every((member) => cosine(vector, member) >= threshold),
    );
    if (found >= 0) {
      groups[found].push(vector);
      return found;
    }
    groups.push([vector]);
    return groups.length - 1;
  });
}
