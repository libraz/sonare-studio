/**
 * Display labels for the device rack: instrument slot captions and insert
 * processor names.
 */

import type { TrackInstrument } from '@/project/instrument';
import type { SynthPatch } from '@/wasm/index.js';
import { patchEditCount } from './patch-draft';

/** Splits a camelCase identifier into a capitalized display name. */
function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Short badge text per instrument kind. */
export function instrumentKindLabel(instrument: TrackInstrument): string {
  switch (instrument.kind) {
    case 'synth-preset':
      return 'Preset';
    case 'synth-patch':
      return 'Patch';
    case 'sf2':
      return 'SF2';
    case 'external-midi':
      return 'MIDI';
    default:
      return '';
  }
}

/** Base-preset caption of a patch ('init' when patch has no base preset). */
export function patchBaseLabel(patch: SynthPatch): string {
  return typeof patch.preset === 'string' && patch.preset.length > 0 ? patch.preset : 'init';
}

/**
 * Main caption of the instrument slot.
 *
 * @param instrument Track instrument.
 * @param fontName Resolved font display name for 'sf2' (falls back to a
 *   shortened font id while unresolved).
 * @returns The caption.
 */
export function instrumentLabel(instrument: TrackInstrument, fontName?: string | null): string {
  switch (instrument.kind) {
    case 'synth-preset':
      return instrument.preset;
    case 'synth-patch': {
      const edits = patchEditCount(instrument.patch);
      return edits > 0
        ? `${patchBaseLabel(instrument.patch)} (edited)`
        : patchBaseLabel(instrument.patch);
    }
    case 'sf2': {
      const name = fontName ?? `${instrument.fontId.slice(0, 8)}…`;
      return `${name} · ${instrument.bank ?? 0}:${instrument.program ?? 0}`;
    }
    case 'external-midi':
      return `External · ch ${instrument.channel + 1}`;
    default:
      return '';
  }
}

/**
 * Display name of an insert processor: the humanized last segment of its
 * catalog name (e.g. 'dynamics.compressor' → 'Compressor').
 */
export function insertLabel(processor: string): string {
  const segments = processor.split('.');
  const last = segments[segments.length - 1] ?? processor;
  return last.length > 0 ? humanize(last) : processor;
}

/**
 * Category caption of an insert processor (the catalog prefix), or '' when
 * the name carries none.
 */
export function insertCategory(processor: string): string {
  const dot = processor.indexOf('.');
  return dot > 0 ? processor.slice(0, dot) : '';
}
