import { beforeEach, describe, expect, it, vi } from 'vitest';

/** C-ABI version the vendored glue checks a module factory against in init(). */
const WASM_ABI_VERSION = 0x04030207;

const ENGINE_ABI_VERSION = 3;

async function importFreshWasm() {
  vi.resetModules();
  return import('@/wasm/index.js');
}

describe('wasm ABI wrapper declarations', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('converts Project clip loop modes to native ABI codes', async () => {
    const calls: unknown[][] = [];
    const wasm = await importFreshWasm();

    class NativeProject {
      setClipLoop(...args: unknown[]): void {
        calls.push(args);
      }
    }

    await wasm.init({
      moduleFactory: async () =>
        ({
          abiVersion: () => WASM_ABI_VERSION,
          projectAbiVersion: () => 1,
          Project: NativeProject,
        }) as never,
    });

    const project = new wasm.Project();
    project.setClipLoop(7, 'loop', 4, 0.25);
    project.setClipLoop(7, 'off');

    expect(calls).toEqual([
      [7, 1, 4, 0.25],
      [7, 0, 0, 0],
    ]);
  });

  it('converts mixer send timing and pan law strings to native ABI codes', async () => {
    const sendCalls: unknown[][] = [];
    const panCalls: unknown[][] = [];
    const wasm = await importFreshWasm();
    const mixer = new wasm.Mixer({
      addSend(...args: unknown[]): number {
        sendCalls.push(args);
        return 3;
      },
      setPanLaw(...args: unknown[]): void {
        panCalls.push(args);
      },
    } as never);

    expect(mixer.addSend(2, 'send-a', 'bus-a', -6, 'preFader')).toBe(3);
    mixer.addSend(2, 'send-b', 'bus-a', -12, 'postFader');
    mixer.setPanLaw(2, 'const6dB');
    mixer.setPanLaw(2, 'linear0dB');

    expect(sendCalls).toEqual([
      [2, 'send-a', 'bus-a', -6, 1],
      [2, 'send-b', 'bus-a', -12, 0],
    ]);
    expect(panCalls).toEqual([
      [2, 2],
      [2, 3],
    ]);
  });

  it('converts realtime track strip pan law strings to native ABI codes', async () => {
    const calls: unknown[][] = [];
    const wasm = await importFreshWasm();

    class NativeRealtimeEngine {
      constructor(...args: unknown[]) {
        calls.push(['constructor', ...args]);
      }

      setTrackStripPanLaw(...args: unknown[]): void {
        calls.push(args);
      }
    }

    await wasm.init({
      moduleFactory: async () =>
        ({
          abiVersion: () => WASM_ABI_VERSION,
          engineAbiVersion: () => ENGINE_ABI_VERSION,
          RealtimeEngine: NativeRealtimeEngine,
        }) as never,
    });

    const engine = new wasm.RealtimeEngine(44100, 256, 32, 64);
    engine.setTrackStripPanLaw(11, 'const4.5dB');
    engine.setTrackStripPanLaw(11, 'const6dB');

    expect(calls).toEqual([
      ['constructor', 44100, 256, 32, 64, 64],
      [11, 1],
      [11, 2],
    ]);
  });
});
