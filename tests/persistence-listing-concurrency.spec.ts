import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAudioAssetCache,
  listAssetPayloads,
  listAssets,
  saveAsset,
} from '@/persistence/assets';
import { listProjects, saveProjectUnlocked } from '@/persistence/opfs';
import { clearFontCache, listFontPayloads, listFonts, saveFont } from '@/project/fonts';
import { installMockOpfs, MemoryFileHandle, uninstallMockOpfs } from './opfs-mock';

/** Slows every getFile() so overlapping calls are observable; returns the peak overlap. */
function trackFileReadConcurrency(): { peak: () => number } {
  const original = MemoryFileHandle.prototype.getFile;
  let inFlight = 0;
  let peak = 0;
  vi.spyOn(MemoryFileHandle.prototype, 'getFile').mockImplementation(async function (
    this: MemoryFileHandle,
  ) {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      return await original.call(this);
    } finally {
      inFlight -= 1;
    }
  });
  return { peak: () => peak };
}

const sf2 = (...payload: number[]): Uint8Array =>
  new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x73, 0x66, 0x62, 0x6b, ...payload]);

describe('independent directory listings', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
    clearFontCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAudioAssetCache();
    clearFontCache();
    uninstallMockOpfs();
  });

  it('reads project file stats concurrently and keeps name order', async () => {
    for (const name of ['c', 'a', 'b']) await saveProjectUnlocked(name, new Uint8Array([1]));
    const tracker = trackFileReadConcurrency();

    const projects = await listProjects();

    expect(projects.map((project) => project.name)).toEqual(['a', 'b', 'c']);
    expect(tracker.peak()).toBeGreaterThan(1);
  });

  it('reads asset sidecars and payload stats concurrently and keeps order', async () => {
    for (const id of ['asset-c', 'asset-a', 'asset-b']) {
      await saveAsset({ id, name: id, sampleRate: 48000 }, [new Float32Array([1, 2])]);
    }
    const tracker = trackFileReadConcurrency();

    const assets = await listAssets();
    expect(assets.map((asset) => asset.id)).toEqual(['asset-a', 'asset-b', 'asset-c']);
    expect(tracker.peak()).toBeGreaterThan(1);

    vi.restoreAllMocks();
    const payloadTracker = trackFileReadConcurrency();
    const payloads = await listAssetPayloads();
    expect(payloads.map((payload) => payload.id)).toEqual(['asset-a', 'asset-b', 'asset-c']);
    expect(payloadTracker.peak()).toBeGreaterThan(1);
  });

  it('reads font sidecars and payload stats concurrently and keeps order', async () => {
    for (const id of ['font-c', 'font-a', 'font-b']) await saveFont({ id, name: id }, sf2(1));
    const tracker = trackFileReadConcurrency();

    const fonts = await listFonts();
    expect(fonts.map((font) => font.id)).toEqual(['font-a', 'font-b', 'font-c']);
    expect(tracker.peak()).toBeGreaterThan(1);

    vi.restoreAllMocks();
    const payloadTracker = trackFileReadConcurrency();
    const payloads = await listFontPayloads();
    expect(payloads.map((payload) => payload.id)).toEqual(['font-a', 'font-b', 'font-c']);
    expect(payloadTracker.peak()).toBeGreaterThan(1);
  });

  it('still skips a malformed asset sidecar', async () => {
    await saveAsset({ id: 'good', name: 'Good', sampleRate: 48000 }, [new Float32Array([1])]);
    await saveAsset({ id: 'bad', name: 'Bad', sampleRate: 48000 }, [new Float32Array([2])]);
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('assets');
    const writable = await (await dir.getFileHandle('bad.json')).createWritable();
    await writable.write(new TextEncoder().encode('{broken'));
    await writable.close();

    expect((await listAssets()).map((asset) => asset.id)).toEqual(['good']);
  });
});
