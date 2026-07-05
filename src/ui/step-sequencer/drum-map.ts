/**
 * General MIDI percussion map (channel 10, key range 35-81) used to label
 * drum-mode rows. The names follow the GM1 sound set; they intentionally
 * match what the wasm Project.gmDrumName helper reports so labels stay
 * consistent across the app without loading the wasm module here.
 */
import { formatPitch } from '@/lib/pitch';

const GM_DRUM_NAMES: Readonly<Record<number, string>> = {
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
};

/** First pitch covered by the GM percussion map. */
export const GM_DRUM_MIN_PITCH = 35;
/** Last pitch covered by the GM percussion map. */
export const GM_DRUM_MAX_PITCH = 81;

/**
 * Returns the GM percussion name for a pitch, or null outside 35-81.
 *
 * @param pitch MIDI note number.
 */
export function gmDrumName(pitch: number): string | null {
  return GM_DRUM_NAMES[pitch] ?? null;
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
