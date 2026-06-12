import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createTransportSync } from '@/engine/transport-sync';
import type { EditorMarker, TempoSegment, TimeSignatureSegment } from '@/project/types';

/** EngineHandle stub capturing the transport commands. */
function makeHandle(): {
  handle: EngineHandle;
  engine: {
    setTempoSegments: ReturnType<typeof vi.fn>;
    setTimeSignatureSegments: ReturnType<typeof vi.fn>;
    setMarkers: ReturnType<typeof vi.fn>;
  };
} {
  const engine = {
    setTempoSegments: vi.fn(),
    setTimeSignatureSegments: vi.fn(),
    setMarkers: vi.fn(),
  };
  const handle = { engine } as unknown as EngineHandle;
  return { handle, engine };
}

/** Builds a marker with overridable fields. */
function makeMarker(id: number, ppq: number, name = `Marker ${id}`): EditorMarker {
  return { id, ppq, name };
}

describe('createTransportSync', () => {
  it('sends engine defaults when the project has no segments', () => {
    const { handle, engine } = makeHandle();
    const sync = createTransportSync(handle);

    sync.sync([], [], []);
    expect(engine.setTempoSegments).toHaveBeenCalledTimes(1);
    expect(engine.setTempoSegments).toHaveBeenCalledWith([{ startPpq: 0, bpm: 120 }]);
    expect(engine.setTimeSignatureSegments).toHaveBeenCalledTimes(1);
    expect(engine.setTimeSignatureSegments).toHaveBeenCalledWith([
      { startPpq: 0, numerator: 4, denominator: 4 },
    ]);
    expect(engine.setMarkers).toHaveBeenCalledTimes(1);
    expect(engine.setMarkers).toHaveBeenCalledWith([]);
  });

  it('sends nothing on an identical second sync', () => {
    const { handle, engine } = makeHandle();
    const sync = createTransportSync(handle);
    const tempo: TempoSegment[] = [{ startPpq: 0, bpm: 90 }];
    const meter: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 3, denominator: 4 }];
    const markers = [makeMarker(1, 4)];

    sync.sync(tempo, meter, markers);
    engine.setTempoSegments.mockClear();
    engine.setTimeSignatureSegments.mockClear();
    engine.setMarkers.mockClear();

    sync.sync(tempo, meter, markers);
    expect(engine.setTempoSegments).not.toHaveBeenCalled();
    expect(engine.setTimeSignatureSegments).not.toHaveBeenCalled();
    expect(engine.setMarkers).not.toHaveBeenCalled();
  });

  it('re-sends only the markers when only the markers changed', () => {
    const { handle, engine } = makeHandle();
    const sync = createTransportSync(handle);

    sync.sync([], [], [makeMarker(1, 4)]);
    engine.setTempoSegments.mockClear();
    engine.setTimeSignatureSegments.mockClear();
    engine.setMarkers.mockClear();

    sync.sync([], [], [makeMarker(1, 8)]);
    expect(engine.setTempoSegments).not.toHaveBeenCalled();
    expect(engine.setTimeSignatureSegments).not.toHaveBeenCalled();
    expect(engine.setMarkers).toHaveBeenCalledTimes(1);
    expect(engine.setMarkers).toHaveBeenCalledWith([{ id: 1, ppq: 8, name: 'Marker 1' }]);
  });

  it('keeps marker ids and names and sorts them by ppq', () => {
    const { handle, engine } = makeHandle();
    const sync = createTransportSync(handle);

    sync.sync([], [], [makeMarker(7, 16, 'Outro'), makeMarker(3, 0, 'Intro'), makeMarker(5, 8)]);
    expect(engine.setMarkers).toHaveBeenCalledWith([
      { id: 3, ppq: 0, name: 'Intro' },
      { id: 5, ppq: 8, name: 'Marker 5' },
      { id: 7, ppq: 16, name: 'Outro' },
    ]);
  });

  it('passes endBpm through on ramped segments and omits it otherwise', () => {
    const { handle, engine } = makeHandle();
    const sync = createTransportSync(handle);
    const tempo: TempoSegment[] = [
      { startPpq: 4, bpm: 60 },
      { startPpq: 0, bpm: 120, endBpm: 60 },
    ];

    sync.sync(tempo, [], []);
    expect(engine.setTempoSegments).toHaveBeenCalledTimes(1);
    expect(engine.setTempoSegments.mock.calls[0][0]).toStrictEqual([
      { startPpq: 0, bpm: 120, endBpm: 60 },
      { startPpq: 4, bpm: 60 },
    ]);
  });
});
