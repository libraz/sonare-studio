/**
 * General MIDI percussion map (channel 10, key range 27-87) used to label
 * drum-mode rows. The names follow the GM2 percussion key map, which keeps the
 * GM1 sound set on 35-81 — those match what the wasm Project.gmDrumName helper
 * reports, so labels stay consistent across the app without loading the wasm
 * module here — and extends it with 27-34 and 82-87. The extension is not
 * cosmetic: the drum generator writes a shaker on 82.
 */
import { formatPitch } from '@/lib/pitch';

const GM_DRUM_NAMES: Readonly<Record<number, string>> = {
  27: 'High Q',
  28: 'Slap',
  29: 'Scratch Push',
  30: 'Scratch Pull',
  31: 'Sticks',
  32: 'Square Click',
  33: 'Metronome Click',
  34: 'Metronome Bell',
  35: 'Acoustic Bass Drum',
  36: 'Bass Drum 1',
  37: 'Side Stick',
  38: 'Acoustic Snare',
  39: 'Hand Clap',
  40: 'Electric Snare',
  41: 'Low Floor Tom',
  42: 'Closed Hi-Hat',
  43: 'High Floor Tom',
  44: 'Pedal Hi-Hat',
  45: 'Low Tom',
  46: 'Open Hi-Hat',
  47: 'Low-Mid Tom',
  48: 'Hi-Mid Tom',
  49: 'Crash Cymbal 1',
  50: 'High Tom',
  51: 'Ride Cymbal 1',
  52: 'Chinese Cymbal',
  53: 'Ride Bell',
  54: 'Tambourine',
  55: 'Splash Cymbal',
  56: 'Cowbell',
  57: 'Crash Cymbal 2',
  58: 'Vibraslap',
  59: 'Ride Cymbal 2',
  60: 'Hi Bongo',
  61: 'Low Bongo',
  62: 'Mute Hi Conga',
  63: 'Open Hi Conga',
  64: 'Low Conga',
  65: 'High Timbale',
  66: 'Low Timbale',
  67: 'High Agogo',
  68: 'Low Agogo',
  69: 'Cabasa',
  70: 'Maracas',
  71: 'Short Whistle',
  72: 'Long Whistle',
  73: 'Short Guiro',
  74: 'Long Guiro',
  75: 'Claves',
  76: 'Hi Wood Block',
  77: 'Low Wood Block',
  78: 'Mute Cuica',
  79: 'Open Cuica',
  80: 'Mute Triangle',
  81: 'Open Triangle',
  82: 'Shaker',
  83: 'Jingle Bell',
  84: 'Bell Tree',
  85: 'Castanets',
  86: 'Mute Surdo',
  87: 'Open Surdo',
};

/** First pitch covered by the GM percussion map. */
export const GM_DRUM_MIN_PITCH = 27;
/** Last pitch covered by the GM percussion map. */
export const GM_DRUM_MAX_PITCH = 87;

/**
 * Returns the GM percussion name for a pitch, or null outside 27-87.
 *
 * @param pitch MIDI note number.
 */
export function gmDrumName(pitch: number): string | null {
  return GM_DRUM_NAMES[pitch] ?? null;
}

/** GM2 drum-set bank: MSB 120 selects a percussion kit, the LSB picks it. */
export const GM2_DRUM_BANK_MSB = 120;

/**
 * Encodes the SF2 channel-map bank number that selects a GM2 drum/SFX kit
 * (bank MSB 120, kit in the LSB).
 *
 * @param kitLsb Kit index (bank LSB, 0-127).
 */
export function gm2DrumBank(kitLsb: number): number {
  return (GM2_DRUM_BANK_MSB << 7) | (kitLsb & 0x7f);
}

/**
 * Minimal shape of the wasm GM2 percussion helpers, injected by UI callers so
 * this module stays free of a hard dependency on the wasm store.
 */
export interface DrumKitNameSource {
  gm2DrumSetName?: (bankLsb: number) => string | null;
  gm2DrumName?: (bankLsb: number, note: number) => string | null;
}

/**
 * Display name of a GM2 drum/SFX kit (bank LSB), via the wasm helper. Returns
 * null when the kit is unnamed or the helper is unavailable.
 *
 * @param kitLsb Kit index (bank LSB, 0-127).
 * @param source wasm Project helpers (e.g. `getWasmModule().Project`).
 */
export function gm2DrumKitName(
  kitLsb: number,
  source: DrumKitNameSource | undefined,
): string | null {
  try {
    return source?.gm2DrumSetName?.(kitLsb & 0x7f) ?? null;
  } catch {
    return null;
  }
}

/**
 * Percussion name for a pitch in a specific GM2 drum kit, falling back to the
 * standard percussion map name (then null) when the kit has no override or the
 * helper is unavailable.
 *
 * @param pitch MIDI note number.
 * @param kitLsb Kit index (bank LSB, 0-127); omitted uses the standard map only.
 * @param source wasm Project helpers (e.g. `getWasmModule().Project`).
 */
export function drumNoteName(
  pitch: number,
  kitLsb?: number,
  source?: DrumKitNameSource,
): string | null {
  if (kitLsb !== undefined && source) {
    try {
      const name = source.gm2DrumName?.(kitLsb & 0x7f, pitch);
      if (name) return name;
    } catch {
      // fall through to the GM1 map
    }
  }
  return gmDrumName(pitch);
}

/**
 * Default drum-mode rows in display order (top to bottom): the most-used
 * subset of the GM kit covering cymbals, hats, toms, clap, snare and kick.
 */
export const DEFAULT_DRUM_KIT: ReadonlyArray<{ pitch: number; name: string }> = [
  { pitch: 49, name: GM_DRUM_NAMES[49] },
  { pitch: 51, name: GM_DRUM_NAMES[51] },
  { pitch: 46, name: GM_DRUM_NAMES[46] },
  { pitch: 42, name: GM_DRUM_NAMES[42] },
  { pitch: 50, name: GM_DRUM_NAMES[50] },
  { pitch: 47, name: GM_DRUM_NAMES[47] },
  { pitch: 45, name: GM_DRUM_NAMES[45] },
  { pitch: 39, name: GM_DRUM_NAMES[39] },
  { pitch: 38, name: GM_DRUM_NAMES[38] },
  { pitch: 36, name: GM_DRUM_NAMES[36] },
];

/**
 * Scientific pitch name for a MIDI note (middle C / 60 = C4, matching the
 * piano-roll keyboard labels).
 *
 * @param pitch MIDI note number (integer, 0-127).
 */
export function pitchName(pitch: number): string {
  return formatPitch(pitch);
}
