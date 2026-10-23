import { describe, expect, it } from 'vitest';
import { collectGsSetupSysex } from '@/engine/gs-sysex';
import { type NoteBoundaryEvent, pairNoteBoundariesIntoNotes } from '@/project/midi-events';
import { extractSmfSysEx } from '@/project/smf';

function boundary(
  over: Partial<NoteBoundaryEvent> & Pick<NoteBoundaryEvent, 'ppq' | 'kind'>,
): NoteBoundaryEvent {
  return { channel: 0, pitch: 60, velocity: 100, ...over };
}

describe('note pairing with repeated zero-length hits', () => {
  it('drops every zero-length hit instead of lengthening them into the next hit', () => {
    const notes = pairNoteBoundariesIntoNotes(
      [0, 1, 2].flatMap((ppq) => [
        boundary({ ppq, kind: 'on' }),
        boundary({ ppq, kind: 'off', velocity: 0 }),
      ]),
    );
    expect(notes).toEqual([]);
  });

  it('keeps a real note that follows zero-length hits at its own length', () => {
    const notes = pairNoteBoundariesIntoNotes([
      boundary({ ppq: 0, kind: 'on' }),
      boundary({ ppq: 0, kind: 'off', velocity: 0 }),
      boundary({ ppq: 1, kind: 'on' }),
      boundary({ ppq: 3, kind: 'off', velocity: 0 }),
    ]);
    expect(notes).toEqual([{ pitch: 60, velocity: 100, startPpq: 1, durationPpq: 2, channel: 0 }]);
  });
});

/** Builds an SMF with the given chunks after a format-1 header. */
function smf(chunks: Array<{ id: string; body: number[] }>): Uint8Array {
  const bytes = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0, 96];
  for (const { id, body } of chunks) {
    bytes.push(...[...id].map((c) => c.charCodeAt(0)), 0, 0, 0, body.length, ...body);
  }
  return Uint8Array.from(bytes);
}

describe('extractSmfSysEx', () => {
  it('skips unknown chunks and reads SysEx from later tracks', () => {
    const bytes = smf([
      { id: 'XFIH', body: [1, 2, 3] },
      { id: 'MTrk', body: [0x00, 0xf0, 0x03, 0x41, 0x10, 0xf7, 0x00, 0xff, 0x2f, 0x00] },
    ]);
    expect(extractSmfSysEx(bytes)).toEqual([{ ppq: 0, status: 0xf0, data: [0x41, 0x10, 0xf7] }]);
  });
});

describe('collectGsSetupSysex', () => {
  const frame = (ppq: number, tag: number) => ({
    ppq,
    status: 0xf0 as const,
    data: [0x41, tag, 0xf7],
  });

  it('applies complete frames placed after the reset but before the first note', () => {
    const result = collectGsSetupSysex([
      {
        startPpq: 0,
        notes: [{ startPpq: 4 }],
        smfSysEx: [frame(0, 1), frame(1, 2), frame(4, 3), frame(5, 4)],
      },
    ]);
    expect(result.frames.map((f) => f[2])).toEqual([1, 2]);
    expect(result.unsupportedPacketCount).toBe(2);
  });
});
