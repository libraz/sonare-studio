import { getWasmModule } from '@/project/store';

/** Built-in mixer scene presets exposed by current libsonare builds. */
export const FALLBACK_MIXER_SCENE_PRESETS: readonly string[] = [
  'vocalReverbSend',
  'drumBusSubgroup',
  'commentaryDucking',
];

const FALLBACK_SCENE_JSON: Readonly<Record<string, string>> = {
  vocalReverbSend: JSON.stringify({
    version: 1,
    buses: [
      { id: 'master', role: 'master', inserts: [] },
      { id: 'vocal-verb', role: 'aux', inserts: [] },
    ],
    connections: [
      { source: 'vocal', destination: 'master' },
      { source: 'vocal-verb', destination: 'vocal-verb-return' },
      { source: 'vocal-verb-return', destination: 'master' },
    ],
    strips: [
      {
        id: 'vocal',
        faderDb: -3,
        pan: 0,
        width: 1,
        muted: false,
        soloed: false,
        soloSafe: false,
        sends: [
          { id: 'vocal-to-verb', destinationBusId: 'vocal-verb', sendDb: -14, timing: 'post' },
        ],
        inserts: [
          {
            slot: 'pre',
            processor: 'dynamics.compressor',
            params: { thresholdDb: -18, ratio: 2.5 },
          },
        ],
      },
      {
        id: 'vocal-verb-return',
        faderDb: -10,
        pan: 0,
        width: 1.25,
        muted: false,
        soloed: false,
        sends: [],
        inserts: [
          {
            slot: 'post',
            processor: 'stereo.imager',
            params: { width: 1.35 },
          },
        ],
      },
    ],
    vcaGroups: [],
  }),
  drumBusSubgroup: JSON.stringify({
    version: 1,
    buses: [
      { id: 'master', role: 'master', inserts: [] },
      { id: 'drum-bus', role: 'subgroup', inserts: [] },
    ],
    connections: [
      { source: 'kick', destination: 'drum-bus' },
      { source: 'snare', destination: 'drum-bus' },
      { source: 'overheads', destination: 'drum-bus' },
      { source: 'drum-bus', destination: 'drum-bus-return' },
      { source: 'drum-bus-return', destination: 'master' },
    ],
    strips: [
      { id: 'kick', faderDb: -3, pan: 0, sends: [], inserts: [] },
      { id: 'snare', faderDb: -3, pan: 0, sends: [], inserts: [] },
      { id: 'overheads', faderDb: -6, pan: 0, sends: [], inserts: [] },
      {
        id: 'drum-bus-return',
        faderDb: -2,
        pan: 0,
        sends: [],
        inserts: [
          {
            slot: 'pre',
            processor: 'dynamics.parallelComp',
            params: { thresholdDb: -20, mix: 0.35 },
          },
        ],
      },
    ],
    vcaGroups: [{ id: 'drums', gainDb: 0, members: ['kick', 'snare', 'overheads'] }],
  }),
  commentaryDucking: JSON.stringify({
    version: 1,
    buses: [{ id: 'master', role: 'master', inserts: [] }],
    connections: [
      { source: 'host', destination: 'master' },
      { source: 'guest', destination: 'master' },
      { source: 'music-bed', destination: 'master' },
    ],
    strips: [
      {
        id: 'host',
        faderDb: -3,
        pan: 0,
        sends: [],
        inserts: [
          {
            slot: 'pre',
            processor: 'dynamics.deesser',
            params: { frequencyHz: 6000, thresholdDb: -24 },
          },
        ],
      },
      {
        id: 'guest',
        faderDb: -4,
        pan: 0.1,
        sends: [],
        inserts: [
          {
            slot: 'pre',
            processor: 'dynamics.compressor',
            params: { thresholdDb: -22, ratio: 2.5 },
          },
        ],
      },
      {
        id: 'music-bed',
        faderDb: -18,
        pan: 0,
        sends: [],
        inserts: [
          {
            slot: 'post',
            processor: 'dynamics.sidechainRouter',
            sidechainKey: 'host',
            params: { rangeDb: 18 },
          },
        ],
      },
    ],
    vcaGroups: [{ id: 'voices', gainDb: 0, members: ['host', 'guest'] }],
  }),
};

const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  vocalReverbSend: 'Vocal Reverb Send',
  drumBusSubgroup: 'Drum Bus Subgroup',
  commentaryDucking: 'Commentary Ducking',
};

export function humanizeMixerScenePreset(id: string): string {
  const override = LABEL_OVERRIDES[id];
  if (override !== undefined) return override;
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function loadMixerScenePresetCatalog(): string[] {
  try {
    const wasm = getWasmModule() as unknown as { mixingScenePresetNames?: () => string[] };
    const names = wasm.mixingScenePresetNames?.();
    if (names && names.length > 0) return names;
  } catch {
    // Module not loaded yet; fall back below.
  }
  return [...FALLBACK_MIXER_SCENE_PRESETS];
}

export function loadMixerScenePresetJson(preset: string): string {
  try {
    const wasm = getWasmModule() as unknown as {
      mixingScenePresetJson?: (preset: string) => string;
    };
    const json = wasm.mixingScenePresetJson?.(preset);
    if (json && json.length > 0) return json;
  } catch {
    // Module not loaded yet; fall back below.
  }
  const fallback = FALLBACK_SCENE_JSON[preset];
  if (!fallback) throw new RangeError(`Unknown mixer scene preset: ${preset}`);
  return fallback;
}
