import { EPSILON, meanPitch, type VoiceUnit } from '@/notation/voice-unit';

/** Split-near pitches can follow the previous hand instead of flipping staves. */
const GRAND_STAFF_AMBIGUOUS_SEMITONES = 7;

/** Maximum melodic leap allowed when carrying an ambiguous note across the split. */
const GRAND_STAFF_CONTINUITY_SEMITONES = 18;

/**
 * Widest span (in semitones, roughly a tenth) a single chord unit may keep on
 * one staff. A unit wider than this that also straddles the split is a
 * two-hand cluster, so its notes are divided between the staves rather than
 * forced onto the staff of its mean pitch.
 */
const GRAND_STAFF_HAND_SPAN_SEMITONES = 16;

/**
 * Grand-staff split rule: a mean pitch at or above the split engraves to the
 * upper staff (1 = treble), below it to the lower staff (2 = bass).
 *
 * This is the single source of truth for the "mean vs split" decision shared
 * by unit, channel-bias, and serializer staff assignment.
 */
export function staffForMeanPitch(mean: number, splitPitch: number): 1 | 2 {
  return mean >= splitPitch ? 1 : 2;
}

/**
 * Last pitch engraved on each staff, tracked per hand rather than as a running
 * group mean so a fast line's continuity anchor follows its most recent note
 * instead of being blurred by simultaneous notes on the other staff.
 */
interface GrandStaffContinuity {
  upperPitch?: number;
  lowerPitch?: number;
}

/**
 * Derives a per-channel staff bias from pitch samples grouped by channel.
 *
 * When at least two channels sound and the spread between their highest and
 * lowest mean pitch reaches {@link GRAND_STAFF_AMBIGUOUS_SEMITONES}, each
 * channel biases to a staff by its mean (via {@link staffForMeanPitch}) and
 * the topmost/bottommost channels are pinned to the upper/lower staff. Returns
 * an empty map when there is no clear two-hand separation.
 */
function channelStaffBiasFromSamples(
  samples: Iterable<{ channel: number; pitch: number }>,
  splitPitch: number,
): ReadonlyMap<number, 1 | 2> {
  const stats = new Map<number, { sum: number; count: number }>();
  for (const { channel, pitch } of samples) {
    const stat = stats.get(channel) ?? { sum: 0, count: 0 };
    stat.sum += pitch;
    stat.count += 1;
    stats.set(channel, stat);
  }
  const means = [...stats.entries()]
    .filter(([, stat]) => stat.count > 0)
    .map(([channel, stat]) => ({ channel, mean: stat.sum / stat.count }))
    .sort((a, b) => b.mean - a.mean);
  if (means.length < 2) return new Map();
  if (means[0].mean - means[means.length - 1].mean < GRAND_STAFF_AMBIGUOUS_SEMITONES) {
    return new Map();
  }

  const bias = new Map<number, 1 | 2>();
  for (const entry of means) {
    bias.set(entry.channel, staffForMeanPitch(entry.mean, splitPitch));
  }
  bias.set(means[0].channel, 1);
  bias.set(means[means.length - 1].channel, 2);
  return bias;
}

function grandStaffChannelBias(units: VoiceUnit[], splitPitch: number): ReadonlyMap<number, 1 | 2> {
  const samples: Array<{ channel: number; pitch: number }> = [];
  for (const unit of units) {
    if (unit.channels.length !== 1) continue;
    samples.push({ channel: unit.channels[0], pitch: meanPitch(unit.pitches) });
  }
  return channelStaffBiasFromSamples(samples, splitPitch);
}

function nearestStaffByContinuity(pitch: number, context: GrandStaffContinuity): 1 | 2 | undefined {
  const upperDistance =
    context.upperPitch === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(pitch - context.upperPitch);
  const lowerDistance =
    context.lowerPitch === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(pitch - context.lowerPitch);
  const best = Math.min(upperDistance, lowerDistance);
  if (best > GRAND_STAFF_CONTINUITY_SEMITONES) return undefined;
  if (upperDistance < lowerDistance) return 1;
  if (lowerDistance < upperDistance) return 2;
  return undefined;
}

function grandStaffForPitch(
  pitch: number,
  splitPitch: number,
  context: GrandStaffContinuity,
): 1 | 2 {
  const defaultStaff = staffForMeanPitch(pitch, splitPitch);
  if (Math.abs(pitch - splitPitch) > GRAND_STAFF_AMBIGUOUS_SEMITONES) return defaultStaff;
  return nearestStaffByContinuity(pitch, context) ?? defaultStaff;
}

function grandStaffForUnit(
  unit: VoiceUnit,
  splitPitch: number,
  context: GrandStaffContinuity,
  channelBias: ReadonlyMap<number, 1 | 2>,
): 1 | 2 {
  if (unit.channels.length === 1) {
    const biased = channelBias.get(unit.channels[0]);
    if (biased !== undefined) return biased;
  }
  return grandStaffForPitch(meanPitch(unit.pitches), splitPitch, context);
}

/**
 * Divides an oversized chord unit that straddles the split into an upper-staff
 * and a lower-staff unit (notes at/above the split go up, the rest go down),
 * or returns undefined when the unit fits within one hand and stays whole.
 *
 * The two halves share the unit's timing, velocity, channels, and source ids;
 * each keeps only its own pitches so the serializer emits the correct `<staff>`
 * per note.
 */
export function splitUnitAcrossStaves(
  unit: VoiceUnit,
  splitPitch: number,
): { upper: VoiceUnit; lower: VoiceUnit } | undefined {
  const lowest = unit.pitches[0];
  const highest = unit.pitches[unit.pitches.length - 1];
  const straddles = lowest < splitPitch && highest >= splitPitch;
  if (!straddles || highest - lowest <= GRAND_STAFF_HAND_SPAN_SEMITONES) return undefined;
  return {
    upper: { ...unit, pitches: unit.pitches.filter((pitch) => pitch >= splitPitch) },
    lower: { ...unit, pitches: unit.pitches.filter((pitch) => pitch < splitPitch) },
  };
}

export function assignGrandStaffUnits(
  units: VoiceUnit[],
  splitPitch: number,
): { upper: VoiceUnit[]; lower: VoiceUnit[] } {
  const upper: VoiceUnit[] = [];
  const lower: VoiceUnit[] = [];
  const context: GrandStaffContinuity = {};
  const channelBias = grandStaffChannelBias(units, splitPitch);
  const ordered = [...units].sort(
    (a, b) => a.startPpq - b.startPpq || meanPitch(b.pitches) - meanPitch(a.pitches),
  );
  for (let i = 0; i < ordered.length; ) {
    const start = ordered[i].startPpq;
    const group: VoiceUnit[] = [];
    while (i < ordered.length && Math.abs(ordered[i].startPpq - start) <= EPSILON) {
      group.push(ordered[i]);
      i++;
    }
    // Assign the whole onset group against the pre-group context so
    // simultaneous notes never bias one another, then advance the per-hand
    // continuity to each staff's last note.
    const next: GrandStaffContinuity = { ...context };
    for (const unit of group) {
      const wide = splitUnitAcrossStaves(unit, splitPitch);
      if (wide !== undefined) {
        upper.push(wide.upper);
        lower.push(wide.lower);
        next.upperPitch = meanPitch(wide.upper.pitches);
        next.lowerPitch = meanPitch(wide.lower.pitches);
        continue;
      }
      const pitch = meanPitch(unit.pitches);
      const staff = grandStaffForUnit(unit, splitPitch, context, channelBias);
      if (staff === 1) {
        upper.push(unit);
        next.upperPitch = pitch;
      } else {
        lower.push(unit);
        next.lowerPitch = pitch;
      }
    }
    context.upperPitch = next.upperPitch;
    context.lowerPitch = next.lowerPitch;
  }
  return { upper, lower };
}
