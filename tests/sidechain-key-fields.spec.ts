import { describe, expect, it } from 'vitest';
import { inspectDawprojectExportLoss } from '@/export/dawproject/export-loss';
import { createSonareDawprojectMetadata } from '@/export/dawproject/sonare-metadata';
import {
  DOCUMENT_SIDECHAIN_INDEX_FIELDS,
  type DocumentInsertSlot,
  resolveMixerSidechainSourceIds,
  SIDECHAIN_KEY_FIELDS,
  stripWithSidechainSourceIds,
} from '@/project/document-mixer-references';
import { createDefaultMixerState, createDefaultStrip } from '@/project/mixer';
import type { DocumentTrack, ProjectDocument } from '@/project/serialization';

const keyValue = (field: string): number | string => (field === 'sidechainSourceBusId' ? 'bus' : 1);

function slotWith(field: string): DocumentInsertSlot {
  return {
    processor: 'dynamics.compressor',
    params: {},
    enabled: true,
    [field]: keyValue(field),
  } as DocumentInsertSlot;
}

function docWith(slot: DocumentInsertSlot): ProjectDocument {
  const track = (inserts: DocumentInsertSlot[]): DocumentTrack => ({
    name: 'T',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [],
    mixer: { ...createDefaultStrip(), inserts },
  });
  return {
    schemaVersion: 3,
    name: 'D',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [track([slot]), track([])],
    markers: [],
    sections: [],
  };
}

describe('sidechain key field list', () => {
  it('includes every document index field', () => {
    for (const field of DOCUMENT_SIDECHAIN_INDEX_FIELDS) {
      expect(SIDECHAIN_KEY_FIELDS).toContain(field);
    }
  });

  it('is covered by the export loss inspection: only the track index survives', () => {
    for (const field of SIDECHAIN_KEY_FIELDS) {
      const lost = inspectDawprojectExportLoss(docWith(slotWith(field))).entries;
      if (field === 'sidechainSourceIndex') expect(lost).toEqual([]);
      else expect(lost, field).toEqual([{ kind: 'sidechainKeys', count: 1, details: [] }]);
    }
  });

  it('is covered by the metadata sidecar: only the track index is carried', () => {
    for (const field of SIDECHAIN_KEY_FIELDS) {
      const metadata = createSonareDawprojectMetadata(docWith(slotWith(field)));
      if (field === 'sidechainSourceIndex') {
        expect(metadata.sidechainSources, field).toEqual({ 'channel-0-insert-0': 1 });
      } else {
        expect(metadata.sidechainSources, field).toBeUndefined();
      }
    }
  });

  it('scrubs every document index field when rebinding to session ids', () => {
    const tracks = [{ id: 10 }, { id: 11 }];
    for (const field of DOCUMENT_SIDECHAIN_INDEX_FIELDS) {
      const strip = { ...createDefaultStrip(), inserts: [slotWith(field)] };
      const [slot] = stripWithSidechainSourceIds(strip, tracks).inserts;
      expect(field in slot, field).toBe(false);

      const mixer = { ...createDefaultMixerState(), master: strip };
      resolveMixerSidechainSourceIds(mixer, tracks);
      expect(field in mixer.master.inserts[0], field).toBe(false);
    }
  });
});
