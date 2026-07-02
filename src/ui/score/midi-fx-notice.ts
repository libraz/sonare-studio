import { midiFxConfigJson } from '@/project/midi-fx';
import type { EditorTrack } from '@/project/types';

/** True when playback/export MIDI-FX are active but score engraving still shows source notes. */
export function scoreOmitsMidiFx(track: EditorTrack | null | undefined): boolean {
  if (!track?.midiFx || track.kind !== 'midi') return false;
  return midiFxConfigJson(track.midiFx) !== null;
}
