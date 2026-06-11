/**
 * Shared in-memory stand-in for the libsonare wasm module, used by specs that
 * exercise the project store/commands without real wasm.
 *
 * The fake mimics the behaviors the production code depends on:
 * - toJson() emits the real snake_case document shape (tracks, clips,
 *   midi_content, tempo_segments, time_signatures, markers).
 * - The undo history granularity matches the real binding: most edits push
 *   one history entry; addClip pushes two (source registration + clip add)
 *   and addMidiClip pushes three (source + track + clip). setClipSource and
 *   setClipFade push one entry each.
 * - splitClip partitions MIDI events between the halves and tracks source
 *   offsets the way the real Project does.
 * - addClip registers one source per call (inline audio fields or a
 *   by-reference sourceUri are recorded on it); sourceCount() reports the
 *   total and source ids are allocated as 1, 2, 3, ... in registration order.
 */

interface FakeEvent {
  ppq: number;
  data0: number;
  data1: number;
}

interface FakeTrack {
  id: number;
  kind: number;
  name: string;
}

interface FakeClip {
  id: number;
  track_id: number;
  start_ppq: number;
  length_ppq: number;
  source_offset_ppq: number;
  gain: number;
  loop_mode: number;
  loop_length_ppq: number;
  source_id: number;
  fade_in_ppq: number;
  fade_out_ppq: number;
}

/** One registered audio/MIDI source (inline audio or by-reference URI). */
interface FakeSource {
  id: number;
  uri?: string;
  audioFrames?: number;
  audioChannels?: number;
  audioSampleRate?: number;
}

interface FakeMarker {
  id: number;
  ppq: number;
  name: string;
}

interface FakeState {
  tempoSegments: Array<{ startPpq: number; bpm: number; endBpm: number }>;
  timeSignatures: Array<{ startPpq: number; numerator: number; denominator: number }>;
  tracks: FakeTrack[];
  clips: FakeClip[];
  midi: Map<number, FakeEvent[]>;
  markers: FakeMarker[];
  sourceCount: number;
  sources: Map<number, FakeSource>;
}

/** Packs a UMP MIDI 1.0 channel-voice word with the real binding layout. */
function pack(
  group: number,
  status: number,
  channel: number,
  data1: number,
  data2: number,
): number {
  return (
    ((0x2 << 28) | (group << 24) | (status << 20) | (channel << 16) | (data1 << 8) | data2) >>> 0
  );
}

function trackKindOrdinal(kind: unknown): number {
  if (kind === 'audio' || kind === 0) return 0;
  if (kind === 'aux' || kind === 2) return 2;
  return 1;
}

function cloneState(state: FakeState): FakeState {
  return {
    tempoSegments: state.tempoSegments.map((s) => ({ ...s })),
    timeSignatures: state.timeSignatures.map((s) => ({ ...s })),
    tracks: state.tracks.map((t) => ({ ...t })),
    clips: state.clips.map((c) => ({ ...c })),
    midi: new Map([...state.midi].map(([id, events]) => [id, events.map((e) => ({ ...e }))])),
    markers: state.markers.map((m) => ({ ...m })),
    sourceCount: state.sourceCount,
    sources: new Map([...state.sources].map(([id, source]) => [id, { ...source }])),
  };
}

/** In-memory Project stand-in; see the module doc comment for fidelity notes. */
export class FakeProject {
  private sampleRate = 48000;
  private state: FakeState = {
    tempoSegments: [],
    timeSignatures: [],
    tracks: [],
    clips: [],
    midi: new Map(),
    markers: [],
    sourceCount: 0,
    sources: new Map(),
  };
  private history: FakeState[] = [];
  private future: FakeState[] = [];
  private nextTrackId = 1;
  private nextClipId = 1;
  private nextMarkerId = 1;
  private deleted = false;
  private soundFont: Uint8Array | null = null;

  static midiNoteOn(
    ppq: number,
    group: number,
    channel: number,
    note: number,
    velocity: number,
  ): FakeEvent {
    return { ppq, data0: pack(group, 0x9, channel, note, velocity), data1: 0 };
  }

  static midiNoteOff(
    ppq: number,
    group: number,
    channel: number,
    note: number,
    velocity = 0,
  ): FakeEvent {
    return { ppq, data0: pack(group, 0x8, channel, note, velocity), data1: 0 };
  }

  static midiProgram(ppq: number, group: number, channel: number, program: number): FakeEvent {
    return { ppq, data0: pack(group, 0xc, channel, program, 0), data1: 0 };
  }

  static midiBankProgram(
    ppq: number,
    group: number,
    channel: number,
    bankMsb: number,
    bankLsb: number,
    program: number,
  ): FakeEvent[] {
    // Bank select CC0/CC32 followed by the program change, like the binding.
    return [
      { ppq, data0: pack(group, 0xb, channel, 0, bankMsb), data1: 0 },
      { ppq, data0: pack(group, 0xb, channel, 32, bankLsb), data1: 0 },
      FakeProject.midiProgram(ppq, group, channel, program),
    ];
  }

  /** Pushes one history entry, then applies the mutation. */
  private edit<T>(mutate: () => T): T {
    this.history.push(cloneState(this.state));
    this.future.length = 0;
    return mutate();
  }

  setSampleRate(sampleRate: number): void {
    this.sampleRate = sampleRate;
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  setTempoSegments(
    segments: ReadonlyArray<{ startPpq: number; bpm: number; endBpm?: number }>,
  ): void {
    this.edit(() => {
      this.state.tempoSegments = segments.map((s) => ({
        startPpq: s.startPpq,
        bpm: s.bpm,
        endBpm: s.endBpm ?? 0,
      }));
    });
  }

  setTimeSignatures(
    segments: ReadonlyArray<{ startPpq: number; numerator: number; denominator: number }>,
  ): void {
    this.edit(() => {
      this.state.timeSignatures = segments.map((s) => ({ ...s }));
    });
  }

  addTrack(desc: { kind?: unknown; name?: string } = {}): number {
    return this.edit(() => {
      const id = this.nextTrackId++;
      this.state.tracks.push({
        id,
        kind: trackKindOrdinal(desc.kind),
        name: desc.name ?? '',
      });
      return id;
    });
  }

  removeTrack(trackId: number): void {
    this.edit(() => {
      this.state.tracks = this.state.tracks.filter((t) => t.id !== trackId);
      const dropped = this.state.clips.filter((c) => c.track_id === trackId);
      for (const clip of dropped) this.state.midi.delete(clip.id);
      this.state.clips = this.state.clips.filter((c) => c.track_id !== trackId);
    });
  }

  renameTrack(trackId: number, name: string): void {
    this.edit(() => {
      const track = this.state.tracks.find((t) => t.id === trackId);
      if (!track) throw new Error(`unknown track ${trackId}`);
      track.name = name;
    });
  }

  addClip(desc: {
    trackId: number;
    isMidi?: boolean;
    startPpq?: number;
    lengthPpq: number;
    sourceOffsetPpq?: number;
    gain?: number;
    audio?: Float32Array;
    audioChannels?: number;
    audioSampleRate?: number;
    sourceUri?: string;
  }): number {
    // The real binding rejects non-MIDI clips without inline audio data
    // (by-reference sources still carry a placeholder buffer).
    if (desc.isMidi === false && (desc.audio === undefined || desc.audio.length === 0)) {
      throw new Error('audio clip requires non-empty inline audio data');
    }
    // The real binding registers a source first (one history entry), then
    // adds the clip (a second entry).
    const sourceId = this.edit(() => {
      this.state.sourceCount += 1;
      const source: FakeSource = { id: this.state.sourceCount };
      if (desc.sourceUri !== undefined) source.uri = desc.sourceUri;
      if (desc.audio !== undefined) {
        const channels = desc.audioChannels ?? 1;
        source.audioChannels = channels;
        source.audioFrames = Math.floor(desc.audio.length / channels);
        source.audioSampleRate = desc.audioSampleRate ?? 48000;
      }
      this.state.sources.set(this.state.sourceCount, source);
      return this.state.sourceCount;
    });
    return this.edit(() => {
      const id = this.nextClipId++;
      this.state.clips.push({
        id,
        track_id: desc.trackId,
        start_ppq: desc.startPpq ?? 0,
        length_ppq: desc.lengthPpq,
        source_offset_ppq: desc.sourceOffsetPpq ?? 0,
        gain: desc.gain ?? 1,
        loop_mode: 0,
        loop_length_ppq: 0,
        source_id: sourceId,
        fade_in_ppq: 0,
        fade_out_ppq: 0,
      });
      if (desc.isMidi !== false) this.state.midi.set(id, []);
      return id;
    });
  }

  /** Number of audio/MIDI sources registered on the project. */
  sourceCount(): number {
    return this.state.sourceCount;
  }

  /** Rebinds a clip to an already-registered source (one history entry). */
  setClipSource(clipId: number, sourceId: number): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      if (!this.state.sources.has(sourceId)) throw new Error(`unknown source ${sourceId}`);
      clip.source_id = sourceId;
    });
  }

  /** Sets a clip's fade-in/out lengths (one history entry). */
  setClipFade(
    clipId: number,
    fadeIn?: { lengthPpq?: number },
    fadeOut?: { lengthPpq?: number },
  ): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      if (fadeIn !== undefined) clip.fade_in_ppq = fadeIn.lengthPpq ?? 0;
      if (fadeOut !== undefined) clip.fade_out_ppq = fadeOut.lengthPpq ?? 0;
    });
  }

  addMidiClip(startPpq: number, lengthPpq: number): { trackId: number; clipId: number } {
    const trackId = this.edit(() => {
      const id = this.nextTrackId++;
      this.state.tracks.push({ id, kind: 1, name: 'midi' });
      return id;
    });
    const clipId = this.addClip({ trackId, isMidi: true, startPpq, lengthPpq });
    return { trackId, clipId };
  }

  private requireClip(clipId: number): FakeClip {
    const clip = this.state.clips.find((c) => c.id === clipId);
    if (!clip) throw new Error(`unknown clip ${clipId}`);
    return clip;
  }

  removeClip(clipId: number): void {
    this.edit(() => {
      this.requireClip(clipId);
      this.state.clips = this.state.clips.filter((c) => c.id !== clipId);
      this.state.midi.delete(clipId);
    });
  }

  moveClip(clipId: number, newStartPpq: number, newTrackId?: number): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      clip.start_ppq = newStartPpq;
      if (newTrackId !== undefined) clip.track_id = newTrackId;
    });
  }

  trimClip(clipId: number, newStartPpq: number, newLengthPpq: number): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      clip.source_offset_ppq += newStartPpq - clip.start_ppq;
      clip.start_ppq = newStartPpq;
      clip.length_ppq = newLengthPpq;
    });
  }

  splitClip(clipId: number, splitPpq: number): number {
    return this.edit(() => {
      const clip = this.requireClip(clipId);
      const id = this.nextClipId++;
      const leftLength = splitPpq - clip.start_ppq;
      const splitSourcePpq = clip.source_offset_ppq + leftLength;
      this.state.clips.push({
        id,
        track_id: clip.track_id,
        start_ppq: splitPpq,
        length_ppq: clip.length_ppq - leftLength,
        source_offset_ppq: splitSourcePpq,
        gain: clip.gain,
        loop_mode: clip.loop_mode,
        loop_length_ppq: clip.loop_length_ppq,
        source_id: clip.source_id,
        // The fade-out travels with the right half; the left keeps the
        // fade-in only.
        fade_in_ppq: 0,
        fade_out_ppq: clip.fade_out_ppq,
      });
      clip.length_ppq = leftLength;
      clip.fade_out_ppq = 0;
      const events = this.state.midi.get(clipId) ?? [];
      this.state.midi.set(
        clipId,
        events.filter((e) => e.ppq < splitSourcePpq),
      );
      this.state.midi.set(
        id,
        events.filter((e) => e.ppq >= splitSourcePpq).map((e) => ({ ...e })),
      );
      return id;
    });
  }

  duplicateClip(clipId: number, newStartPpq: number): number {
    return this.edit(() => {
      const clip = this.requireClip(clipId);
      const id = this.nextClipId++;
      this.state.clips.push({ ...clip, id, start_ppq: newStartPpq });
      this.state.midi.set(
        id,
        (this.state.midi.get(clipId) ?? []).map((e) => ({ ...e })),
      );
      return id;
    });
  }

  setClipGain(clipId: number, gain: number): void {
    this.edit(() => {
      this.requireClip(clipId).gain = gain;
    });
  }

  setClipLoop(clipId: number, loopMode: string | number, loopLengthPpq?: number): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      clip.loop_mode = loopMode === 'loop' || loopMode === 1 ? 1 : 0;
      clip.loop_length_ppq = clip.loop_mode === 1 ? (loopLengthPpq ?? 0) : 0;
    });
  }

  setMidiEvents(clipId: number, events: ReadonlyArray<FakeEvent>): void {
    this.edit(() => {
      this.requireClip(clipId);
      this.state.midi.set(
        clipId,
        events.map((e) => ({ ppq: e.ppq, data0: e.data0, data1: e.data1 ?? 0 })),
      );
    });
  }

  setMarker(markerId: number, ppq: number, name: string): number {
    return this.edit(() => {
      if (markerId === 0) {
        const id = this.nextMarkerId++;
        this.state.markers.push({ id, ppq, name });
        return id;
      }
      const marker = this.state.markers.find((m) => m.id === markerId);
      if (marker) {
        marker.ppq = ppq;
        marker.name = name;
      } else {
        this.state.markers.push({ id: markerId, ppq, name });
      }
      return markerId;
    });
  }

  undo(): void {
    const previous = this.history.pop();
    if (!previous) return;
    this.future.push(cloneState(this.state));
    this.state = previous;
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(cloneState(this.state));
    this.state = next;
  }

  snapToGrid(ppq: number, strength = 1): number {
    const target = Math.round(ppq);
    return ppq + (target - ppq) * strength;
  }

  trackCount(): number {
    return this.state.tracks.length;
  }

  /** Records the SoundFont bytes (not part of the undo history). */
  loadSoundFont(data: Uint8Array): void {
    this.soundFont = new Uint8Array(data);
  }

  clearSoundFont(): void {
    this.soundFont = null;
  }

  soundFontPresetCount(): number {
    return this.soundFont ? 1 : 0;
  }

  /** Deterministic stereo render stand-in (3 frames, interleaved L/R). */
  bounceWithSynthInstrument(_instrument?: unknown, _options?: unknown): Float32Array {
    return new Float32Array([0.25, -0.25, 0.5, -0.5, 0.75, -0.75]);
  }

  /** Deterministic SF2 render stand-in (2 frames, interleaved L/R). */
  bounceWithSf2Instrument(_instrument?: unknown, _options?: unknown): Float32Array {
    return new Float32Array([0.2, -0.2, 0.4, -0.4]);
  }

  exportSmf(): Uint8Array {
    // Deterministic placeholder: a MIDI header chunk tag plus content counts.
    return new Uint8Array([0x4d, 0x54, 0x68, 0x64, this.state.clips.length & 0xff]);
  }

  exportClipFile(): Uint8Array {
    return new Uint8Array([0x53, 0x4d, 0x46, 0x32, this.state.clips.length & 0xff]);
  }

  toJson(): string {
    return JSON.stringify({
      sample_rate: this.sampleRate,
      tempo_segments: this.state.tempoSegments.map((s) => ({
        start_ppq: s.startPpq,
        bpm: s.bpm,
        end_bpm: s.endBpm,
        start_sample: 0,
      })),
      time_signatures: this.state.timeSignatures.map((s) => ({
        start_ppq: s.startPpq,
        numerator: s.numerator,
        denominator: s.denominator,
      })),
      tracks: this.state.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name })),
      clips: this.state.clips.map((c) => ({ ...c })),
      markers: this.state.markers.map((m) => ({ ...m })),
      midi_content: Object.fromEntries(
        [...this.state.midi].map(([id, events]) => [String(id), events.map((e) => ({ ...e }))]),
      ),
      version: 1,
    });
  }

  delete(): void {
    if (this.deleted) throw new Error('Project deleted twice');
    this.deleted = true;
  }
}

/** Mirrors libsonare's scale helper for highlightedPitchClasses tests. */
export function scalePitchClassEnabled(
  root: number,
  modeMask: number,
  pitchClass: number,
): boolean {
  return ((modeMask >> ((((pitchClass - root) % 12) + 12) % 12)) & 1) === 1;
}

/** Synth preset names the fake catalog reports (subset of the real build). */
export const FAKE_SYNTH_PRESETS = [
  'sine',
  'saw-lead',
  'square-lead',
  'e-piano',
  'acoustic-piano',
  'warm-pad',
  'sub-bass',
  'pluck',
  'organ',
  'brass',
  'electric-guitar',
  'drum-kit',
] as const;

/** Insert parameter names per processor the fake catalog reports. */
export const FAKE_INSERT_PARAMS: Record<string, string[]> = {
  'dynamics.compressor': [
    'thresholdDb',
    'ratio',
    'attackMs',
    'releaseMs',
    'kneeDb',
    'makeupGainDb',
  ],
  'eq.tilt': ['tiltDb', 'pivotHz'],
  'saturation.tape': ['driveDb', 'saturation', 'outputGainDb'],
  'stereo.imager': ['width', 'outputGainDb'],
};

/** Mastering preset names the fake catalog reports (subset of the real build). */
export const FAKE_MASTERING_PRESETS = ['pop', 'edm', 'acoustic', 'hipHop', 'speech'] as const;

/** Mirrors masteringPresetNames for catalog-aware code paths. */
export function fakeMasteringPresetNames(): string[] {
  return [...FAKE_MASTERING_PRESETS];
}

/** Mirrors synthPresetNames for catalog-aware code paths. */
export function fakeSynthPresetNames(): string[] {
  return [...FAKE_SYNTH_PRESETS];
}

/** Mirrors synthPresetPatch: known presets return a patch, unknown throw. */
export function fakeSynthPresetPatch(name: string): Record<string, unknown> {
  const bare = name.startsWith('va:') ? name.slice(3) : name;
  if (!(FAKE_SYNTH_PRESETS as readonly string[]).includes(bare)) {
    throw new Error(`unknown synth preset: ${name}`);
  }
  return { preset: bare, cutoffHz: 12000, resonanceQ: 0.9, ampSustain: 0.6, gain: 0.8 };
}

/** Sample peak of one buffer (helper for the metering fakes). */
function fakePeak(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) {
    const a = Math.abs(sample);
    if (a > peak) peak = a;
  }
  return peak;
}

/** Mirrors meteringPeakDb: sample peak in dBFS (-Infinity for silence). */
export function fakeMeteringPeakDb(samples: Float32Array, _sampleRate = 48000): number {
  const peak = fakePeak(samples);
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

/**
 * Mirrors meteringTruePeakDb's shape; the fake skips oversampling and
 * reports the plain sample peak.
 */
export function fakeMeteringTruePeakDb(
  samples: Float32Array,
  _sampleRate = 48000,
  _oversampleFactor = 0,
): number {
  return fakeMeteringPeakDb(samples);
}

/**
 * Mirrors the lufs() result shape with a deterministic energy-based estimate
 * (no K-weighting/gating; integratedLufs = -0.691 + 10*log10(mean square)).
 */
export function fakeLufs(
  samples: Float32Array,
  _sampleRate = 48000,
): { integratedLufs: number; momentaryLufs: number; shortTermLufs: number; loudnessRange: number } {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const meanSquare = samples.length > 0 ? sum / samples.length : 0;
  const loudness = meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : Number.NEGATIVE_INFINITY;
  return {
    integratedLufs: loudness,
    momentaryLufs: loudness,
    shortTermLufs: loudness,
    loudnessRange: 0,
  };
}

/**
 * Mirrors masterAudioStereo's result envelope; the fake applies no DSP and
 * copies the input through (preset chains need the real wasm).
 */
export function fakeMasterAudioStereo(
  left: Float32Array,
  right: Float32Array,
  sampleRate = 48000,
  _presetName?: string,
  _overrides?: Record<string, number | boolean> | null,
): {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  inputLufs: number;
  outputLufs: number;
  appliedGainDb: number;
  stages: string[];
} {
  return {
    left: new Float32Array(left),
    right: new Float32Array(right),
    sampleRate,
    inputLufs: 0,
    outputLufs: 0,
    appliedGainDb: 0,
    stages: [],
  };
}

/**
 * Identity StreamingEqualizer stand-in (copies its input through). The
 * production seam only constructs, configures bands, processes once and
 * deletes; nothing here needs real filtering.
 */
export class FakeStreamingEqualizer {
  setBand(_index: number, _band: object): void {}
  processStereo(
    left: Float32Array,
    right: Float32Array,
  ): { left: Float32Array; right: Float32Array } {
    return { left: new Float32Array(left), right: new Float32Array(right) };
  }
  delete(): void {}
}

/** Builds a fake module compatible with the `@/lib/wasm` ensureWasm result. */
export function createFakeWasmModule(): typeof import('@/wasm/index.js') {
  return {
    Project: FakeProject,
    scalePitchClassEnabled,
    init: async () => {},
    synthPresetNames: fakeSynthPresetNames,
    synthPresetPatch: fakeSynthPresetPatch,
    masteringInsertNames: () => Object.keys(FAKE_INSERT_PARAMS),
    masteringInsertParamNames: (name: string) => FAKE_INSERT_PARAMS[name] ?? [],
    masteringPresetNames: fakeMasteringPresetNames,
    // Pass-through one-shot stereo processor: copies the input unchanged.
    masteringProcessStereo: (
      _name: string,
      left: Float32Array,
      right: Float32Array,
      sampleRate = 48000,
      _params?: Record<string, number | boolean>,
    ) => ({
      left: new Float32Array(left),
      right: new Float32Array(right),
      sampleRate,
      inputLufs: 0,
      outputLufs: 0,
      appliedGainDb: 0,
      latencySamples: 0,
    }),
    StreamingEqualizer: FakeStreamingEqualizer,
    masterAudioStereo: fakeMasterAudioStereo,
    meteringPeakDb: fakeMeteringPeakDb,
    meteringTruePeakDb: fakeMeteringTruePeakDb,
    lufs: fakeLufs,
  } as unknown as typeof import('@/wasm/index.js');
}
