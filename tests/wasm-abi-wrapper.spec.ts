import * as wasm from '@libraz/libsonare';
import { beforeAll, describe, expect, it } from 'vitest';
import { coreWasmBinary } from './core-package';

/** The vendored wrapper turns the core's string tokens into native codes; these run the real module. */
beforeAll(async () => {
  await wasm.init({
    wasmBinary: coreWasmBinary(),
  } as Parameters<typeof wasm.init>[0]);
});

describe('wasm token conversion against the real module', () => {
  it('stores Project clip loop modes and reads them back as tokens', () => {
    const project = new wasm.Project();
    try {
      const trackId = project.addTrack({ name: 'Loop', kind: 'midi' });
      const clipId = project.addClip({ trackId, isMidi: true, startPpq: 0, lengthPpq: 4 });

      project.setClipLoop(clipId, { loopMode: 'loop', loopLengthPpq: 2, loopCrossfadePpq: 0.25 });
      const looped = project.clips().find((clip) => clip.id === clipId);
      expect(looped).toMatchObject({ loopMode: 'loop', loopLengthPpq: 2 });

      project.setClipLoop(clipId, { loopMode: 'off' });
      expect(project.clips().find((clip) => clip.id === clipId)?.loopMode).toBe('off');
    } finally {
      project.destroy();
    }
  });

  it('keeps mixer send timing and pan law tokens in the serialized scene', () => {
    const mixer = new wasm.Mixer({ sampleRate: 48000 });
    try {
      mixer.addBus('bus-a');
      mixer.addStrip('strip-1');
      expect(
        mixer.addSend('strip-1', {
          id: 'send-a',
          destinationBusId: 'bus-a',
          sendDb: -6,
          timing: 'preFader',
        }),
      ).toBe(0);
      mixer.addSend('strip-1', {
        id: 'send-b',
        destinationBusId: 'bus-a',
        sendDb: -12,
        timing: 'postFader',
      });
      mixer.setPanLaw('strip-1', 'const6Db');

      const strip = JSON.parse(mixer.toJson()).strips[0];
      expect(strip.panLaw).toBe('const6Db');
      expect(strip.sends.map((send: { timing: string }) => send.timing)).toEqual([
        'preFader',
        'postFader',
      ]);
    } finally {
      mixer.destroy();
    }
  });

  it('accepts every core pan law on a realtime strip and refuses an unknown one', () => {
    const engine = new wasm.RealtimeEngine({ sampleRate: 44100, maxBlockSize: 256 });
    try {
      engine.setTrackLanes([{ trackId: 11 }]);
      engine.setStrip(11, { id: 'track-11' });
      const laws: wasm.PanLaw[] = ['const3Db', 'const4.5Db', 'const6Db', 'linear0Db'];
      for (const law of laws) expect(() => engine.setStripPanLaw(11, law)).not.toThrow();
      expect(() => engine.setStripPanLaw(11, 'const3dB' as wasm.PanLaw)).toThrow();
    } finally {
      engine.destroy();
    }
  });
});
