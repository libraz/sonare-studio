import { describe, expect, it } from 'vitest';
import { flattenClipLeaves, readAudioClip, readMidiClip } from '@/export/dawproject/clip-import';
import type { DawprojectImportLoss } from '@/export/dawproject/import';
import { normalizeTempoMap } from '@/project/tempo-map';

function parse(xml: string): Element {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc.documentElement;
}

const tempoMap = normalizeTempoMap([{ startPpq: 0, bpm: 120 }]);

describe('DAWproject clip content window', () => {
  it('places MIDI expression points relative to the play start like the notes', () => {
    const clip = parse(`<Clip time="0" duration="4" playStart="4">
      <Notes><Note time="6" duration="1" key="60" vel="0.8"/></Notes>
      <Points unit="linear">
        <Target expression="channelController" channel="0" controller="1"/>
        <RealPoint time="6" value="40"/>
        <RealPoint time="2" value="10"/>
      </Points>
    </Clip>`);
    const losses: DawprojectImportLoss[] = [];
    const out = readMidiClip(clip, undefined, losses);
    expect(out.sourceOffsetPpq).toBe(4);
    expect(out.notes[0].startPpq).toBe(6);
    expect(out.ccLanes?.[0].points.map((p) => p.ppq)).toEqual([2]);
  });

  it('aligns a loop that starts after the play start and reports the dropped lead-in', () => {
    const clip = parse(`<Clip time="0" duration="16" playStart="0" loopStart="4" loopEnd="8">
      <Notes><Note time="5" duration="1" key="60" vel="0.8"/></Notes>
    </Clip>`);
    const losses: DawprojectImportLoss[] = [];
    const out = readMidiClip(clip, undefined, losses);
    expect(out.loopEnabled).toBe(true);
    expect(out.loopLengthPpq).toBe(4);
    expect(out.sourceOffsetPpq).toBe(4);
    expect(losses).toEqual([
      { kind: 'unsupported-nested-clip', clipName: 'MIDI clip', reason: 'loop-start-offset' },
    ]);
  });

  it('keeps a loop that starts at the play start without a loss', () => {
    const clip = parse(`<Clip time="0" duration="16" playStart="2" loopStart="2" loopEnd="6"/>`);
    const losses: DawprojectImportLoss[] = [];
    const out = readMidiClip(clip, undefined, losses);
    expect(out.sourceOffsetPpq).toBe(2);
    expect(losses).toEqual([]);
  });

  it('derives the audio source offset of a nested leaf from the parent window', () => {
    const parent = parse(`<Clip time="0" duration="4" playStart="2" contentTimeUnit="beats">
      <Clips>
        <Clip time="0" duration="8" playStart="0" contentTimeUnit="beats"/>
      </Clips>
    </Clip>`);
    const losses: DawprojectImportLoss[] = [];
    const [leaf] = flattenClipLeaves(parent, losses);
    expect(leaf.placement.contentWindowStart).toBe(2);
    const out = readAudioClip(leaf.element, tempoMap, new Map(), losses, leaf.placement);
    expect(out.sourceOffsetPpq).toBe(2);
  });

  it('converts a seconds play start of a standalone audio clip to beats', () => {
    const clip = parse(`<Clip time="0" duration="4" playStart="1" contentTimeUnit="seconds"/>`);
    const out = readAudioClip(clip, tempoMap, new Map(), []);
    expect(out.sourceOffsetPpq).toBeCloseTo(2, 6);
  });
});
