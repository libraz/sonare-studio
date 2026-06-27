import type { ProjectAssistSidecar } from '@/wasm/index.js';
import { getProject } from '../store';
import { execute } from './history';
import { validatePpq } from './utils';

/**
 * Assist sidecars: opaque, versioned blobs the Project stores alongside the
 * musical content, keyed by module id + target scope (track + PPQ region). They
 * are a reserved persistence slot for AI-annotation metadata — analysis caches,
 * suggestion payloads, model outputs — that travels with the project but does
 * not affect rendering. The studio writes none today; this exposes the
 * undoable write and a read-back so a future assist feature can own the format.
 *
 * NOT YET PERSISTED: serializeProject()/.szd save-load do not round-trip
 * sidecars, so they live only on the in-memory wasm Project and are lost on
 * reload. The first feature to write sidecars MUST add serialization support
 * (see src/project/serialization.ts) before relying on them surviving a save.
 */

/** One stored assist sidecar (mirrors the wasm `ProjectAssistSidecar`). */
export type AssistSidecar = ProjectAssistSidecar;

/**
 * Adds or replaces an assist sidecar as one undoable edit. The Project keys a
 * sidecar by `moduleId` plus its target scope (`targetTrackId` and the
 * `[regionStartPpq, regionEndPpq]` region), so writing the same key again
 * updates that entry in place rather than appending a duplicate.
 *
 * @param moduleId Owning module identifier (non-empty).
 * @param schemaVersion Payload schema version (non-negative integer).
 * @param targetTrackId Scoped track id (0 = whole project).
 * @param regionStartPpq Region start in PPQ (>= 0).
 * @param regionEndPpq Region end in PPQ (>= regionStartPpq).
 * @param payload Opaque bytes (interpreted by the owning module).
 * @throws RangeError on an empty module id, a bad version/track id, an invalid
 *   region, or a non-Uint8Array payload.
 */
export function setAssistSidecar(
  moduleId: string,
  schemaVersion: number,
  targetTrackId: number,
  regionStartPpq: number,
  regionEndPpq: number,
  payload: Uint8Array,
): void {
  if (typeof moduleId !== 'string' || moduleId.length === 0) {
    throw new RangeError('Assist sidecar moduleId must not be empty');
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new RangeError(
      `Assist sidecar schemaVersion must be a non-negative integer, got ${schemaVersion}`,
    );
  }
  if (!Number.isInteger(targetTrackId) || targetTrackId < 0) {
    throw new RangeError(
      `Assist sidecar targetTrackId must be a non-negative integer, got ${targetTrackId}`,
    );
  }
  validatePpq(regionStartPpq, 'Assist sidecar regionStartPpq');
  validatePpq(regionEndPpq, 'Assist sidecar regionEndPpq');
  if (regionEndPpq < regionStartPpq) {
    throw new RangeError('Assist sidecar regionEndPpq must be >= regionStartPpq');
  }
  if (!(payload instanceof Uint8Array)) {
    throw new RangeError('Assist sidecar payload must be a Uint8Array');
  }
  const project = getProject();
  execute(1, () => {
    project.setAssistSidecar(
      moduleId,
      schemaVersion,
      targetTrackId,
      regionStartPpq,
      regionEndPpq,
      payload,
    );
  });
}

/**
 * Reads back every assist sidecar currently stored on the project, in the
 * Project's stable order. A plain read (no history entry).
 *
 * @returns The stored sidecars (empty when none).
 */
export function listAssistSidecars(): AssistSidecar[] {
  const project = getProject();
  const count = project.assistSidecarCount();
  const sidecars: AssistSidecar[] = [];
  for (let i = 0; i < count; i++) sidecars.push(project.getAssistSidecar(i));
  return sidecars;
}
