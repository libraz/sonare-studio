import { type MidiFxConfig, midiFxConfigJson, sanitizeMidiFxConfig } from '../midi-fx';
import { getProject, useProjectStore } from '../store';
import { execute } from './history';
import { requireClip } from './utils';

/**
 * Bakes a MIDI-FX transform into a clip's stored notes as one undoable edit.
 * The engine applies transpose, grid quantize, velocity scale/offset/curve,
 * timing/velocity humanize and chord harmonize destructively; the result is
 * read back into the mirror so it plays back (and bounces) like any edit. A
 * no-op transform (every field at its identity value) is skipped silently.
 *
 * @param clipId Target MIDI clip id.
 * @param config The transform to apply (sanitized internally).
 * @returns True when the clip was changed, false when the transform was a no-op.
 * @throws RangeError when the clip is unknown or not a MIDI clip.
 */
export function bakeClipMidiFx(clipId: number, config: MidiFxConfig): boolean {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  if ((clip.kind ?? 'midi') !== 'midi') {
    throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  }
  const json = midiFxConfigJson(sanitizeMidiFxConfig(config));
  if (json === null) return false;
  const project = getProject();
  execute(1, () => {
    project.bakeMidiFx(clipId, json);
    store.refresh();
  });
  return true;
}
