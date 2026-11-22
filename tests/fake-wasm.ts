/**
 * Shared in-memory stand-in for the libsonare wasm module, used by specs that
 * exercise the project store/commands without real wasm.
 *
 * The fake mimics the behaviors the production code depends on:
 * - toJson() emits the real camelCase document shape (tracks, clips,
 *   midiContent, tempoSegments, timeSignatures, markers, annotation).
 * - The undo history granularity matches the real binding: most edits push
 *   one history entry; addClip pushes one atomic transaction (source
 *   registration + clip add), and addMidiClip pushes one transaction for its
 *   track, source and clip.
 *   setClipSource,
 *   setClipFade, setAudioSourceMetadata and setSampleRate push one entry each.
 * - splitClip partitions MIDI events between the halves and tracks source
 *   offsets the way the real Project does.
 * - addClip registers one source per call (inline audio fields or a
 *   by-reference sourceUri are recorded on it); sources() reports them
 *   and source ids are allocated as 1, 2, 3, ... in registration order.
 */

import type {
  ProjectChordQuality,
  ProjectLoopMode,
  ProjectMarkerKind,
  ProjectTrackKind,
  ProjectWarpMode,
} from '@libraz/libsonare';
import { MASTERING_INSERT_NAMES } from '@libraz/libsonare';

interface FakeEvent {
  ppq: number;
  word0: number;
  word1: number;
}

type ProjectOverlapPolicy = 'disallow' | 'allow';

interface FakeTrack {
  id: number;
  kind: ProjectTrackKind;
  name: string;
}

interface FakeClip {
  id: number;
  track_id: number;
  start_ppq: number;
  length_ppq: number;
  source_offset_ppq: number;
  gain: number;
  loop_mode: ProjectLoopMode;
  loop_length_ppq: number;
  source_id: number;
  fade_in_ppq: number;
  fade_out_ppq: number;
  warp_ref_id?: number;
  warp_mode?: Exclude<ProjectWarpMode, 'off'>;
}

/** One registered audio/MIDI source (inline audio or by-reference URI). */
interface FakeSource {
  id: number;
  uri?: string;
  audioFrames?: number;
  audioChannels?: number;
  audioSampleRate?: number;
  contentHash?: string;
  externalStemRole?: string;
}

interface FakeMarker {
  id: number;
  ppq: number;
  name: string;
  kind?: ProjectMarkerKind;
  key_fifths?: number;
  key_minor?: boolean;
}

/** One chord stored in the annotation stream, in the toJson() shape. */
interface FakeAnnotationChord {
  startPpq: number;
  endPpq: number;
  rootPc: number;
  quality: ProjectChordQuality;
  slashBassPc: number;
  romanNumeral: string;
  extensions: number[];
  modulationBoundary: boolean;
}

/** One stored assist sidecar, mirroring the wasm `ProjectAssistSidecar`. */
interface FakeSidecar {
  moduleId: string;
  schemaVersion: number;
  targetTrackId: number;
  regionStartPpq: number;
  regionEndPpq: number;
  payload: Uint8Array;
}

interface FakeWarpMap {
  id: number;
  name?: string;
  anchors: Array<{ warpSample: number; sourceSample: number }>;
}

/** Complete native-history state, including the allocator cursors. */
interface FakeState {
  sampleRate: number;
  overlapPolicy: ProjectOverlapPolicy;
  tempoSegments: Array<{ startPpq: number; bpm: number; endBpm: number }>;
  timeSignatures: Array<{ startPpq: number; numerator: number; denominator: number }>;
  tracks: FakeTrack[];
  clips: FakeClip[];
  midi: Map<number, FakeEvent[]>;
  markers: FakeMarker[];
  chords: FakeAnnotationChord[];
  sourceCount: number;
  sources: Map<number, FakeSource>;
  assistSidecars: FakeSidecar[];
  warpMaps: Map<number, FakeWarpMap>;
}

/** The MIDI-FX config fields the fake bake reads, in the 2.0 camelCase spelling. */
interface MidiFxConfigFields {
  transposeSemitones?: number;
  velocityScale?: number;
  velocityOffset?: number;
  velocityGamma?: number;
  quantizePpq?: number;
  quantizeStrength?: number;
  chordIntervals?: number[];
  humanizePpq?: number;
  humanizeVelocity?: number;
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

/**
 * Per-event PPQ shift for a MIDI-FX bake's humanize and quantize stages.
 *
 * Timing is decided per note, not per event: the real engine moves a note as a
 * unit, so its note-off inherits the note-on's shift and the duration survives.
 * Shifting the two ends independently would let a quantize collapse a short
 * note to zero length and silently drop it. Note-ons are paired with note-offs
 * FIFO per (channel, pitch), matching the editor's own pairing.
 */
function midiFxTimeShifts(
  events: ReadonlyArray<FakeEvent>,
  humanizePpq: number,
  quantizePpq: number,
  quantizeStrength: number,
): number[] {
  const shifts = new Array<number>(events.length).fill(0);
  if (humanizePpq <= 0 && !(quantizePpq > 0 && quantizeStrength > 0)) return shifts;
  const pending = new Map<string, number[]>();
  events.forEach((event, index) => {
    const w = event.word0 >>> 0;
    const status = (w >>> 20) & 0xf;
    if (status !== 0x8 && status !== 0x9) return;
    const key = `${(w >>> 16) & 0xf}:${(w >>> 8) & 0x7f}`;
    if (status === 0x8) {
      const onIndex = pending.get(key)?.shift();
      if (onIndex !== undefined) shifts[index] = shifts[onIndex];
      return;
    }
    let ppq = event.ppq;
    if (humanizePpq > 0) ppq += ((index % 3) - 1) * humanizePpq * 0.5;
    if (quantizePpq > 0 && quantizeStrength > 0) {
      const target = Math.round(ppq / quantizePpq) * quantizePpq;
      ppq += (target - ppq) * quantizeStrength;
    }
    shifts[index] = ppq - event.ppq;
    const queue = pending.get(key) ?? [];
    queue.push(index);
    pending.set(key, queue);
  });
  return shifts;
}

function trackKind(kind: unknown): ProjectTrackKind {
  if (kind === undefined) return 'midi';
  if (kind === 'audio' || kind === 'midi' || kind === 'aux') return kind;
  throw new TypeError(`track kind must be a name, got ${String(kind)}`);
}

const MARKER_KINDS: readonly ProjectMarkerKind[] = [
  'marker',
  'text',
  'lyric',
  'cuePoint',
  'keySignature',
];

const CHORD_QUALITIES: readonly ProjectChordQuality[] = [
  'unknown',
  'major',
  'minor',
  'diminished',
  'augmented',
  'dominant',
  'halfDiminished',
  'suspended',
];

const WARP_MODES: readonly ProjectWarpMode[] = ['off', 'repitch', 'tempoSync', 'timeStretch'];

/** True when `value` is one of the core's `values` tokens. */
function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

/** The serialized event shape `toJson()` emits. */
function serializedEvent(event: FakeEvent): { ppq: number; word0: number; word1: number } {
  return { ppq: event.ppq, word0: event.word0, word1: event.word1 };
}

function cloneState(state: FakeState): FakeState {
  return {
    sampleRate: state.sampleRate,
    overlapPolicy: state.overlapPolicy,
    tempoSegments: state.tempoSegments.map((s) => ({ ...s })),
    timeSignatures: state.timeSignatures.map((s) => ({ ...s })),
    tracks: state.tracks.map((t) => ({ ...t })),
    clips: state.clips.map((c) => ({ ...c })),
    midi: new Map([...state.midi].map(([id, events]) => [id, events.map((e) => ({ ...e }))])),
    markers: state.markers.map((m) => ({ ...m })),
    chords: state.chords.map((c) => ({ ...c, extensions: [...c.extensions] })),
    sourceCount: state.sourceCount,
    sources: new Map([...state.sources].map(([id, source]) => [id, { ...source }])),
    assistSidecars: state.assistSidecars.map((s) => ({ ...s, payload: s.payload.slice() })),
    warpMaps: new Map(
      [...state.warpMaps].map(([id, map]) => [
        id,
        { ...map, anchors: map.anchors.map((anchor) => ({ ...anchor })) },
      ]),
    ),
  };
}

/** In-memory Project stand-in; see the module doc comment for fidelity notes. */
export class FakeProject {
  private state: FakeState = {
    sampleRate: 48000,
    overlapPolicy: 'disallow',
    tempoSegments: [],
    timeSignatures: [],
    tracks: [],
    clips: [],
    midi: new Map(),
    markers: [],
    chords: [],
    sourceCount: 0,
    sources: new Map(),
    assistSidecars: [],
    warpMaps: new Map(),
  };
  private history: FakeState[] = [];
  private future: FakeState[] = [];
  private maxUndoDepth = Number.POSITIVE_INFINITY;
  private nextTrackId = 1;
  private nextClipId = 1;
  private nextMarkerId = 1;
  private deleted = false;
  private soundFont: Uint8Array | null = null;

  /** Pushes one history entry, then applies the mutation. */
  private edit<T>(mutate: () => T): T {
    this.history.push(cloneState(this.state));
    while (this.history.length > this.maxUndoDepth) this.history.shift();
    this.future.length = 0;
    return mutate();
  }

  setSampleRate(sampleRate: number): void {
    this.edit(() => {
      this.state.sampleRate = sampleRate;
    });
  }

  get sampleRate(): number {
    return this.state.sampleRate;
  }

  setOverlapPolicy(policy: ProjectOverlapPolicy): void {
    if (policy !== 'disallow' && policy !== 'allow') {
      throw new TypeError(`overlap policy must be a name, got ${String(policy)}`);
    }
    this.edit(() => {
      this.state.overlapPolicy = policy;
    });
  }

  get overlapPolicy(): ProjectOverlapPolicy {
    return this.state.overlapPolicy;
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

  setAssistSidecar(input: {
    moduleId: string;
    schemaVersion?: number;
    targetTrackId?: number;
    regionStartPpq?: number;
    regionEndPpq?: number;
    payload?: Uint8Array;
  }): void {
    const {
      moduleId,
      schemaVersion = 0,
      targetTrackId = 0,
      regionStartPpq = 0,
      regionEndPpq = 0,
      payload = new Uint8Array(0),
    } = input;
    this.edit(() => {
      // Keyed by module id + target scope (track + region): same key updates.
      const entry: FakeSidecar = {
        moduleId,
        schemaVersion,
        targetTrackId,
        regionStartPpq,
        regionEndPpq,
        payload: payload.slice(),
      };
      const index = this.state.assistSidecars.findIndex(
        (s) =>
          s.moduleId === moduleId &&
          s.targetTrackId === targetTrackId &&
          s.regionStartPpq === regionStartPpq &&
          s.regionEndPpq === regionEndPpq,
      );
      if (index >= 0) this.state.assistSidecars[index] = entry;
      else this.state.assistSidecars.push(entry);
    });
  }

  assistSidecars(): FakeSidecar[] {
    return this.state.assistSidecars.map((sidecar) => ({
      ...sidecar,
      payload: sidecar.payload.slice(),
    }));
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
        kind: trackKind(desc.kind),
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
    channels?: Float32Array[];
    sampleRate?: number;
    sourceUri?: string;
  }): number {
    // The real binding rejects non-MIDI clips without inline audio data
    // (by-reference sources still carry a placeholder buffer).
    if (
      desc.isMidi === false &&
      (desc.channels === undefined || desc.channels.length === 0 || desc.channels[0].length === 0)
    ) {
      throw new Error('audio clip requires non-empty inline audio data');
    }
    this.assertLaneFree(desc.trackId, desc.startPpq ?? 0, desc.lengthPpq);
    // The real binding registers the source and adds the clip in one native
    // transaction, so one undo restores both together.
    return this.edit(() => {
      const sourceId = this.state.sourceCount + 1;
      this.state.sourceCount = sourceId;
      const source: FakeSource = { id: sourceId };
      if (desc.sourceUri !== undefined) source.uri = desc.sourceUri;
      if (desc.channels !== undefined && desc.channels.length > 0) {
        source.audioChannels = desc.channels.length;
        source.audioFrames = desc.channels[0].length;
        source.audioSampleRate = desc.sampleRate ?? 48000;
      }
      this.state.sources.set(sourceId, source);
      const id = this.nextClipId++;
      this.state.clips.push({
        id,
        track_id: desc.trackId,
        start_ppq: desc.startPpq ?? 0,
        length_ppq: desc.lengthPpq,
        source_offset_ppq: desc.sourceOffsetPpq ?? 0,
        gain: desc.gain ?? 1,
        loop_mode: 'off',
        loop_length_ppq: 0,
        source_id: sourceId,
        fade_in_ppq: 0,
        fade_out_ppq: 0,
      });
      if (desc.isMidi !== false) this.state.midi.set(id, []);
      return id;
    });
  }

  /** Rebinds a clip to an already-registered source (one history entry). */
  setClipSource(clipId: number, sourceId: number): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      if (!this.state.sources.has(sourceId)) throw new Error(`unknown source ${sourceId}`);
      clip.source_id = sourceId;
    });
  }

  /** Replaces an audio source's metadata strings; an omitted string is cleared (one history entry). */
  setAudioSourceMetadata(input: {
    sourceId: number;
    contentHash?: string;
    externalStemRole?: string;
  }): void {
    this.edit(() => {
      const source = this.state.sources.get(input.sourceId);
      if (!source) throw new Error(`unknown source ${input.sourceId}`);
      source.contentHash = input.contentHash;
      source.externalStemRole = input.externalStemRole;
    });
  }

  /** Every registered source in registration order (source ids are 1-based). */
  sources(): Array<{
    id: number;
    kind: 'audio' | 'midi';
    numChannels: number;
    storageHandleId: number;
    sampleRateHint: number;
    nameOrUri: string;
    contentHash?: string;
    externalStemRole?: string;
  }> {
    return [...this.state.sources.values()].map((source) => ({
      id: source.id,
      kind: source.audioChannels === undefined ? 'midi' : 'audio',
      numChannels: source.audioChannels ?? 0,
      storageHandleId: 0,
      sampleRateHint: source.audioSampleRate ?? 0,
      nameOrUri: source.uri ?? '',
      ...(source.contentHash !== undefined ? { contentHash: source.contentHash } : {}),
      ...(source.externalStemRole !== undefined
        ? { externalStemRole: source.externalStemRole }
        : {}),
    }));
  }

  /** Sets a clip's fade-in/out lengths; an omitted length is no fade (one history entry). */
  setClipFade(clipId: number, input: { fadeInPpq?: number; fadeOutPpq?: number }): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      clip.fade_in_ppq = input.fadeInPpq ?? 0;
      clip.fade_out_ppq = input.fadeOutPpq ?? 0;
    });
  }

  addMidiClip(startPpq: number, lengthPpq: number): { trackId: number; clipId: number } {
    // The native addMidiClip transaction contains the track, source and clip.
    return this.edit(() => {
      const trackId = this.nextTrackId++;
      this.state.tracks.push({ id: trackId, kind: 'midi', name: 'midi' });
      const sourceId = this.state.sourceCount + 1;
      this.state.sourceCount = sourceId;
      this.state.sources.set(sourceId, { id: sourceId });
      const clipId = this.nextClipId++;
      this.state.clips.push({
        id: clipId,
        track_id: trackId,
        start_ppq: startPpq,
        length_ppq: lengthPpq,
        source_offset_ppq: 0,
        gain: 1,
        loop_mode: 'off',
        loop_length_ppq: 0,
        source_id: sourceId,
        fade_in_ppq: 0,
        fade_out_ppq: 0,
      });
      this.state.midi.set(clipId, []);
      return { trackId, clipId };
    });
  }

  private strictLanes = false;

  /**
   * Opts this project into the engine's lane rule: under the disallow overlap
   * policy a track holds clips that abut but never overlap, and addClip,
   * moveClip, trimClip and duplicateClip refuse a placement that breaks it.
   * Off by default because many fixtures stack clips at one position.
   */
  enforceClipLanes(enabled = true): void {
    this.strictLanes = enabled;
  }

  private assertLaneFree(
    trackId: number,
    startPpq: number,
    lengthPpq: number,
    ignoreClipId?: number,
  ): void {
    if (!this.strictLanes || this.state.overlapPolicy !== 'disallow') return;
    const eps = 1e-9;
    const clash = this.state.clips.some(
      (c) =>
        c.id !== ignoreClipId &&
        c.track_id === trackId &&
        startPpq < c.start_ppq + c.length_ppq - eps &&
        c.start_ppq < startPpq + lengthPpq - eps,
    );
    if (clash) throw new Error('Invalid state: clip would overlap another clip on the track');
  }

  /** Mirrors the engine: a clip bound to a warp map cannot be trimmed or split. */
  private assertNotWarped(clip: FakeClip): void {
    if (clip.warp_ref_id !== undefined && clip.warp_ref_id > 0) {
      throw new Error('Invalid state: clip is bound to a warp map');
    }
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

  moveClip(clipId: number, newStartPpq: number, options: { trackId?: number } = {}): void {
    const newTrackId = options.trackId;
    const moving = this.requireClip(clipId);
    this.assertLaneFree(newTrackId ?? moving.track_id, newStartPpq, moving.length_ppq, clipId);
    this.edit(() => {
      const clip = this.requireClip(clipId);
      clip.start_ppq = newStartPpq;
      if (newTrackId !== undefined) clip.track_id = newTrackId;
    });
  }

  trimClip(clipId: number, newStartPpq: number, newLengthPpq: number): void {
    const trimmed = this.requireClip(clipId);
    this.assertNotWarped(trimmed);
    this.assertLaneFree(trimmed.track_id, newStartPpq, newLengthPpq, clipId);
    this.edit(() => {
      const clip = this.requireClip(clipId);
      clip.source_offset_ppq += newStartPpq - clip.start_ppq;
      clip.start_ppq = newStartPpq;
      clip.length_ppq = newLengthPpq;
    });
  }

  splitClip(clipId: number, splitPpq: number): number {
    const source = this.requireClip(clipId);
    if (source.loop_mode !== 'off') {
      throw new Error('Turn Loop off before splitting this clip.');
    }
    this.assertNotWarped(source);
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
    const original = this.requireClip(clipId);
    this.assertLaneFree(original.track_id, newStartPpq, original.length_ppq);
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

  setClipLoop(
    clipId: number,
    input: { loopMode: 'off' | 'loop'; loopLengthPpq?: number; loopCrossfadePpq?: number },
  ): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      clip.loop_mode = input.loopMode === 'loop' ? 'loop' : 'off';
      clip.loop_length_ppq = clip.loop_mode === 'loop' ? (input.loopLengthPpq ?? 0) : 0;
    });
  }

  setClipWarpRef(clipId: number, warpRefId: number): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      if (warpRefId <= 0) delete clip.warp_ref_id;
      else clip.warp_ref_id = warpRefId;
    });
  }

  setClipWarpMode(clipId: number, mode: 'off' | 'repitch' | 'tempoSync' | 'timeStretch'): void {
    if (!oneOf(WARP_MODES, mode))
      throw new TypeError(`warp mode must be a name, got ${String(mode)}`);
    this.edit(() => {
      const clip = this.requireClip(clipId);
      if (mode === 'off') delete clip.warp_mode;
      else clip.warp_mode = mode;
    });
  }

  setWarpMap(map: {
    id: number;
    name?: string;
    anchors: ReadonlyArray<{ warpSample: number; sourceSample: number }>;
  }): void {
    this.edit(() => {
      this.state.warpMaps.set(map.id, {
        id: map.id,
        ...(map.name !== undefined ? { name: map.name } : {}),
        anchors: map.anchors.map((anchor) => ({ ...anchor })),
      });
    });
  }

  removeWarpMap(warpRefId: number): void {
    if (!this.state.warpMaps.has(warpRefId)) {
      throw new RangeError(`Unknown warp map id: ${warpRefId}`);
    }
    this.edit(() => {
      this.state.warpMaps.delete(warpRefId);
    });
  }

  setMidiEvents(clipId: number, events: ReadonlyArray<FakeEvent>): void {
    this.edit(() => {
      this.requireClip(clipId);
      this.state.midi.set(
        clipId,
        events.map((e) => ({ ppq: e.ppq, word0: e.word0, word1: e.word1 ?? 0 })),
      );
    });
  }

  /**
   * Applies a MIDI-FX transform to a clip's stored events, mirroring the real
   * engine's verified config semantics (transpose, grid quantize, velocity
   * scale/offset/gamma, bounded humanize, chord harmonize) as one undoable
   * edit. Humanize uses a deterministic index-based jitter so tests stay stable.
   *
   * With `withSourceIndex` the result carries per-output-event provenance in
   * the input event's index space, as measured against the real engine: every
   * event a chord fan-out produces reports the same origin, and the
   * transform's own reordering is reflected in the order of the returned array.
   */
  bakeMidiFx(request: { clipId: number; config: MidiFxConfigFields; withSourceIndex?: boolean }): {
    sourceIndex?: Int32Array;
  } {
    const clipId = request.clipId;
    const cfg = request.config;
    const transpose = cfg.transposeSemitones ?? 0;
    const qPpq = cfg.quantizePpq ?? 0;
    const qStr = cfg.quantizeStrength ?? (qPpq > 0 ? 1 : 0);
    const vScale = cfg.velocityScale ?? 1;
    const vOffset = cfg.velocityOffset ?? 0;
    const vGamma = cfg.velocityGamma ?? 1;
    const hPpq = cfg.humanizePpq ?? 0;
    const hVel = cfg.humanizeVelocity ?? 0;
    const chord = Array.isArray(cfg.chordIntervals) ? cfg.chordIntervals : null;
    const clampU7 = (v: number) => Math.min(127, Math.max(0, Math.round(v)));
    const out: Array<{ event: FakeEvent; source: number }> = [];
    this.edit(() => {
      this.requireClip(clipId);
      const source = this.state.midi.get(clipId) ?? [];
      const timeShift = midiFxTimeShifts(source, hPpq, qPpq, qStr);
      source.forEach((event, index) => {
        const w = event.word0 >>> 0;
        const group = (w >>> 24) & 0xf;
        const status = (w >>> 20) & 0xf;
        const channel = (w >>> 16) & 0xf;
        let note = (w >>> 8) & 0x7f;
        let value = w & 0x7f;
        const isNoteOn = status === 0x9;
        const isNoteOff = status === 0x8;
        const ppq = event.ppq + (timeShift[index] ?? 0);
        if ((isNoteOn || isNoteOff) && transpose !== 0) note = clampU7(note + transpose);
        if (isNoteOn) {
          if (vScale !== 1) value = clampU7(value * vScale);
          if (vOffset !== 0) value = clampU7(value + vOffset);
          if (vGamma !== 1) value = clampU7(127 * (value / 127) ** vGamma);
          if (hVel > 0) value = clampU7(value + ((index % 3) - 1) * hVel);
        }
        const intervals = (isNoteOn || isNoteOff) && chord && chord.length > 0 ? chord : [0];
        for (const interval of intervals) {
          const n = isNoteOn || isNoteOff ? clampU7(note + interval) : note;
          out.push({
            event: { ppq, word0: pack(group, status, channel, n, value), word1: event.word1 },
            source: index,
          });
        }
      });
      out.sort((a, b) => a.event.ppq - b.event.ppq);
      this.state.midi.set(
        clipId,
        out.map((entry) => entry.event),
      );
    });
    return request.withSourceIndex === true
      ? { sourceIndex: Int32Array.from(out.map((entry) => entry.source)) }
      : {};
  }

  /**
   * Counts the events {@link bakeMidiFx} would produce without mutating the
   * project, by running the same fan-out arithmetic the bake uses.
   */
  previewMidiFxCount(request: { clipId: number; config: MidiFxConfigFields }): number {
    const chord = request.config.chordIntervals ?? null;
    const voices = chord && chord.length > 0 ? chord.length : 1;
    const source = this.state.midi.get(request.clipId) ?? [];
    return source.reduce((total, event) => {
      const status = ((event.word0 >>> 0) >>> 20) & 0xf;
      const isNote = status === 0x8 || status === 0x9;
      return total + (isNote ? voices : 1);
    }, 0);
  }

  setMarker(input: {
    id?: number;
    ppq: number;
    name?: string;
    kind?: string;
    keyFifths?: number;
    keyMinor?: boolean;
  }): number {
    if (input.id === 0) throw new RangeError('marker id 0 is refused; omit it to allocate');
    if (input.name === '') throw new RangeError('marker name must not be empty');
    return this.edit(() => {
      const entry: FakeMarker = {
        id: input.id ?? this.nextMarkerId++,
        ppq: input.ppq,
        name: input.name ?? '',
      };
      if (input.kind !== undefined) {
        if (!oneOf(MARKER_KINDS, input.kind))
          throw new TypeError(`marker kind must be a name, got ${input.kind}`);
        entry.kind = input.kind;
      }
      if (input.keyFifths !== undefined) entry.key_fifths = input.keyFifths;
      if (input.keyMinor !== undefined) entry.key_minor = input.keyMinor;
      const existing =
        input.id === undefined ? undefined : this.state.markers.find((m) => m.id === input.id);
      if (existing) Object.assign(existing, entry);
      else this.state.markers.push(entry);
      return entry.id;
    });
  }

  /**
   * Replaces the chord-symbol annotation stream (one undoable edit), mirroring
   * the real Project's behaviour: quality is a name, an omitted pitch class is
   * stored as the 255 "no pitch class" sentinel, omitted extensions become an
   * empty array, and the stored form uses the camelCase shape that toJson()
   * emits.
   */
  annotateChords(
    chords: ReadonlyArray<{
      startPpq: number;
      endPpq: number;
      rootPc?: number;
      quality?: string;
      slashBassPc?: number;
      extensions?: ReadonlyArray<number>;
      romanNumeral?: string;
      modulationBoundary?: boolean;
    }>,
  ): void {
    const qualities = chords.map((c) => {
      const quality = c.quality ?? 'unknown';
      if (!oneOf(CHORD_QUALITIES, quality)) {
        throw new TypeError(`chord quality must be a name, got ${String(c.quality)}`);
      }
      return quality;
    });
    this.edit(() => {
      this.state.chords = chords.map((c, index) => ({
        startPpq: c.startPpq,
        endPpq: c.endPpq,
        rootPc: c.rootPc ?? 255,
        quality: qualities[index],
        slashBassPc: c.slashBassPc ?? 255,
        romanNumeral: c.romanNumeral ?? '',
        extensions: c.extensions ? [...c.extensions] : [],
        modulationBoundary: c.modulationBoundary ?? false,
      }));
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

  clearHistory(): void {
    this.history.length = 0;
    this.future.length = 0;
  }

  setMaxUndoDepth(depth: number): void {
    this.maxUndoDepth = Math.max(1, Math.floor(depth));
    while (this.history.length > this.maxUndoDepth) this.history.shift();
  }

  snapToGrid(ppq: number, strength = 1): number {
    const target = Math.round(ppq);
    return ppq + (target - ppq) * strength;
  }

  /** The fields of `Project.tracks()` entries the specs read. */
  tracks(): Array<{ id: number; name: string }> {
    return this.state.tracks.map((track) => ({ id: track.id, name: track.name }));
  }

  /** Records the SoundFont bytes (not part of the undo history). */
  loadSoundFont(data: Uint8Array): void {
    this.soundFont = new Uint8Array(data);
  }

  clearSoundFont(): void {
    this.soundFont = null;
  }

  get soundFontPresetCount(): number {
    return this.soundFont ? 1 : 0;
  }

  soundFontManifest(): Array<{
    channel: number;
    bank: number;
    program: number;
    backend: 'sf2' | 'synth';
    presetName: string;
  }> {
    const seen = new Set<string>();
    const manifest: Array<{
      channel: number;
      bank: number;
      program: number;
      backend: 'sf2' | 'synth';
      presetName: string;
    }> = [];
    const bankMsb = new Map<number, number>();
    const bankLsb = new Map<number, number>();
    const programByChannel = new Map<number, number>();
    for (const events of this.state.midi.values()) {
      for (const event of events) {
        const status = (event.word0 >>> 20) & 0xf;
        const channel = (event.word0 >>> 16) & 0xf;
        const data1 = (event.word0 >>> 8) & 0xff;
        const data2 = event.word0 & 0xff;
        if (status === 0xb && data1 === 0) bankMsb.set(channel, data2 & 0x7f);
        else if (status === 0xb && data1 === 32) bankLsb.set(channel, data2 & 0x7f);
        else if (status === 0xc) programByChannel.set(channel, data1 & 0x7f);
        else if (status === 0x9 && data2 > 0) {
          const bank = ((bankMsb.get(channel) ?? 0) << 7) | (bankLsb.get(channel) ?? 0);
          const program = programByChannel.get(channel) ?? 0;
          const key = `${channel}:${bank}:${program}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const backend = this.soundFont ? 'sf2' : 'synth';
          manifest.push({
            channel,
            bank,
            program,
            backend,
            presetName: backend === 'sf2' ? `SF2 ${bank}:${program}` : gmInstrumentName(program),
          });
        }
      }
    }
    return manifest;
  }

  /**
   * Deterministic render stand-in: a synth binding renders 3 stereo frames, an
   * SF2 binding 2, anything else silence of `totalFrames`.
   */
  bounce(
    options: {
      totalFrames?: number;
      synthInstruments?: ReadonlyArray<unknown>;
      sf2Instruments?: ReadonlyArray<unknown>;
    } = {},
  ): { channels: Float32Array[]; sampleRate: number } {
    const sampleRate = this.state.sampleRate;
    if (options.synthInstruments && options.synthInstruments.length > 0) {
      return {
        channels: [new Float32Array([0.25, 0.5, 0.75]), new Float32Array([-0.25, -0.5, -0.75])],
        sampleRate,
      };
    }
    if (options.sf2Instruments && options.sf2Instruments.length > 0) {
      return {
        channels: [new Float32Array([0.2, 0.4]), new Float32Array([-0.2, -0.4])],
        sampleRate,
      };
    }
    const frames = options.totalFrames ?? 0;
    return { channels: [new Float32Array(frames), new Float32Array(frames)], sampleRate };
  }

  exportSmf(): Uint8Array {
    // Small but structurally valid SMF: format 0, one empty track, 480 PPQ.
    // Keeping this valid lets app-level export sidecars exercise the same
    // header/track handling as the native writer.
    return new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0,
      4, 0, 0xff, 0x2f, 0,
    ]);
  }

  exportClipFile(): Uint8Array {
    return new Uint8Array([0x53, 0x4d, 0x46, 0x32, this.state.clips.length & 0xff]);
  }

  toJson(): string {
    return JSON.stringify({
      sampleRate: this.state.sampleRate,
      tempoSegments: this.state.tempoSegments.map((s) => ({
        startPpq: s.startPpq,
        bpm: s.bpm,
        endBpm: s.endBpm,
        startSample: 0,
      })),
      timeSignatures: this.state.timeSignatures.map((s) => ({
        startPpq: s.startPpq,
        numerator: s.numerator,
        denominator: s.denominator,
      })),
      tracks: this.state.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name })),
      clips: this.state.clips.map((c) => ({
        id: c.id,
        trackId: c.track_id,
        startPpq: c.start_ppq,
        lengthPpq: c.length_ppq,
        sourceOffsetPpq: c.source_offset_ppq,
        gain: c.gain,
        loopMode: c.loop_mode,
        loopLengthPpq: c.loop_length_ppq,
        sourceId: c.source_id,
        fadeIn: { curve: 'linear', lengthPpq: c.fade_in_ppq },
        fadeOut: { curve: 'linear', lengthPpq: c.fade_out_ppq },
        warpRefId: c.warp_ref_id ?? 0,
        warpMode: c.warp_mode ?? 'off',
      })),
      warpMaps: [...this.state.warpMaps.values()].map((map) => ({
        id: map.id,
        name: map.name,
        anchors: map.anchors.map((anchor) => ({ ...anchor })),
      })),
      markers: this.state.markers.map((m) => ({
        id: m.id,
        ppq: m.ppq,
        name: m.name,
        ...(m.kind !== undefined ? { kind: m.kind } : {}),
        ...(m.key_fifths !== undefined ? { keyFifths: m.key_fifths } : {}),
        ...(m.key_minor !== undefined ? { keyMinor: m.key_minor } : {}),
      })),
      annotation: { chords: this.state.chords.map((c) => ({ ...c })) },
      midiContent: Object.fromEntries(
        [...this.state.midi].map(([id, events]) => [String(id), events.map(serializedEvent)]),
      ),
      version: 7,
    });
  }

  destroy(): void {
    if (this.deleted) throw new Error('Project deleted twice');
    this.deleted = true;
  }
}

/** Mirrors the 2.0 module-level MIDI 1.0 message builders. */
interface FakeMidiBase {
  ppq: number;
  group: number;
  channel: number;
}

export function midiNoteOn(request: FakeMidiBase & { note: number; velocity: number }): FakeEvent {
  const { ppq, group, channel, note, velocity } = request;
  return { ppq, word0: pack(group, 0x9, channel, note, velocity), word1: 0 };
}

export function midiNoteOff(
  request: FakeMidiBase & { note: number; velocity?: number },
): FakeEvent {
  const { ppq, group, channel, note, velocity = 0 } = request;
  return { ppq, word0: pack(group, 0x8, channel, note, velocity), word1: 0 };
}

export function midiProgram(request: FakeMidiBase & { program: number }): FakeEvent {
  const { ppq, group, channel, program } = request;
  return { ppq, word0: pack(group, 0xc, channel, program, 0), word1: 0 };
}

export function midiCc(request: FakeMidiBase & { controller: number; value: number }): FakeEvent {
  const { ppq, group, channel, controller, value } = request;
  return { ppq, word0: pack(group, 0xb, channel, controller, value), word1: 0 };
}

export function midiPolyPressure(
  request: FakeMidiBase & { note: number; pressure: number },
): FakeEvent {
  const { ppq, group, channel, note, pressure } = request;
  return { ppq, word0: pack(group, 0xa, channel, note, pressure), word1: 0 };
}

export function midiChannelPressure(request: FakeMidiBase & { pressure: number }): FakeEvent {
  const { ppq, group, channel, pressure } = request;
  return { ppq, word0: pack(group, 0xd, channel, pressure, 0), word1: 0 };
}

export function midiPitchBend(request: FakeMidiBase & { bend: number }): FakeEvent {
  const { ppq, group, channel, bend } = request;
  return { ppq, word0: pack(group, 0xe, channel, bend & 0x7f, (bend >> 7) & 0x7f), word1: 0 };
}

export function midiBankProgram(
  request: FakeMidiBase & { program: number; bank: { msb: number; lsb: number } },
): FakeEvent[] {
  const { ppq, group, channel, program, bank } = request;
  // Bank select CC0/CC32 followed by the program change, like the binding.
  return [
    { ppq, word0: pack(group, 0xb, channel, 0, bank.msb), word1: 0 },
    { ppq, word0: pack(group, 0xb, channel, 32, bank.lsb), word1: 0 },
    midiProgram({ ppq, group, channel, program }),
  ];
}

export function gmInstrumentName(program: number): string {
  const name = FAKE_GM_INSTRUMENTS[program];
  if (name === undefined) throw new RangeError(`program ${program} is outside 0..127`);
  return name;
}

export function gmProgramForName(name: string): number {
  const index = FAKE_GM_INSTRUMENTS.findIndex(
    (entry) => entry.toLowerCase() === name.toLowerCase(),
  );
  if (index < 0) throw new RangeError(`unknown General MIDI instrument name: ${name}`);
  return index;
}

export function gmFamilyName(family: number): string {
  const name = FAKE_GM_FAMILIES[family];
  if (name === undefined) throw new RangeError(`family ${family} is outside 0..15`);
  return name;
}

export function gmFamilyFirstProgram(family: number): number {
  if (!(family >= 0 && family < FAKE_GM_FAMILIES.length)) {
    throw new RangeError(`family ${family} is outside 0..15`);
  }
  return family * 8;
}

export function gm2InstrumentName(request: {
  bankLsb: number;
  program: number;
}): string | undefined {
  if (request.bankLsb === 1 && request.program === 24) return 'Ukulele';
  if (request.bankLsb === 1 && request.program === 25) return '12-String Guitar';
  return FAKE_GM_INSTRUMENTS[request.program];
}

/** Mirrors libsonare's scale helper for highlightedPitchClasses tests. */
export function scalePitchClassEnabled(
  root: number,
  modeMask: number,
  pitchClass: number,
): boolean {
  return ((modeMask >> ((((pitchClass - root) % 12) + 12) % 12)) & 1) === 1;
}

/**
 * Mirrors libsonare's `scaleQuantizeMidi`: snaps a MIDI value to the nearest
 * pitch class enabled by `modeMask` (relative to `root`), preferring the lower
 * note on a tie. An unchanged value is returned when the note already sits in
 * the scale (or the mask has no enabled pitch class).
 */
export function scaleQuantizeMidi(root: number, modeMask: number, midi: number): number {
  const pc = (value: number): number => ((value % 12) + 12) % 12;
  if (scalePitchClassEnabled(root, modeMask, pc(midi))) return midi;
  for (let d = 1; d <= 6; d++) {
    if (scalePitchClassEnabled(root, modeMask, pc(midi - d))) return midi - d;
    if (scalePitchClassEnabled(root, modeMask, pc(midi + d))) return midi + d;
  }
  return midi;
}

/** Synth preset names the fake catalog reports (subset of the real build). */
export const FAKE_SYNTH_PRESETS = [
  'sine',
  'sawLead',
  'squareLead',
  'ePiano',
  'acousticPiano',
  'warmPad',
  'subBass',
  'pluck',
  'organ',
  'brass',
  'churchOrgan',
  'violin',
  'oboe',
  'concertFlute',
  'electricGuitar',
  'drumKit',
] as const;

const FAKE_GM_FAMILIES = [
  'Piano',
  'Chromatic Percussion',
  'Organ',
  'Guitar',
  'Bass',
  'Strings',
  'Ensemble',
  'Brass',
  'Reed',
  'Pipe',
  'Synth Lead',
  'Synth Pad',
  'Synth Effects',
  'Ethnic',
  'Percussive',
  'Sound Effects',
] as const;

const FAKE_GM_INSTRUMENTS = Array.from({ length: 128 }, (_, index) => `Program ${index}`);
FAKE_GM_INSTRUMENTS[0] = 'Acoustic Grand Piano';
FAKE_GM_INSTRUMENTS[4] = 'Electric Piano 1';
FAKE_GM_INSTRUMENTS[16] = 'Drawbar Organ';
FAKE_GM_INSTRUMENTS[19] = 'Church Organ';
FAKE_GM_INSTRUMENTS[24] = 'Nylon Guitar';
FAKE_GM_INSTRUMENTS[25] = 'Steel Guitar';
FAKE_GM_INSTRUMENTS[26] = 'Jazz Guitar';
FAKE_GM_INSTRUMENTS[27] = 'Clean Guitar';
FAKE_GM_INSTRUMENTS[32] = 'Acoustic Bass';
FAKE_GM_INSTRUMENTS[33] = 'Fingered Bass';
FAKE_GM_INSTRUMENTS[34] = 'Picked Bass';
FAKE_GM_INSTRUMENTS[56] = 'Trumpet';
FAKE_GM_INSTRUMENTS[73] = 'Flute';

/** Insert parameter names per processor the fake catalog reports. */
export const FAKE_INSERT_PARAMS: Record<string, string[]> = {
  'dynamics.compressor': [
    'thresholdDb',
    'ratio',
    'attackMs',
    'releaseMs',
    'kneeDb',
    'makeupGainDb',
    'autoMakeup',
    'detector',
    'sidechainHpfEnabled',
  ],
  'dynamics.limiter': ['thresholdDb', 'lookaheadMs', 'releaseMs'],
  'dynamics.brickwallLimiter': ['ceilingDb', 'lookaheadMs', 'releaseMs'],
  'dynamics.gate': ['thresholdDb', 'attackMs', 'releaseMs', 'rangeDb', 'holdMs'],
  'dynamics.deesser': ['thresholdDb', 'frequencyHz', 'ratio'],
  'dynamics.parallelComp': ['thresholdDb', 'mix'],
  'dynamics.sidechainRouter': ['rangeDb'],
  'eq.tilt': ['tiltDb', 'pivotHz'],
  'effects.reverb.plate': ['mix', 'preDelayMs'],
  'modulation.chorus': ['rateHz', 'depth', 'mix'],
  'modulation.flanger': ['rateHz', 'depth', 'feedback', 'mix'],
  'modulation.rotary': ['speed', 'drive', 'mix'],
  'saturation.tape': ['driveDb', 'saturation', 'outputGainDb'],
  'saturation.softClipper': ['driveDb', 'ceiling', 'mix'],
  'saturation.waveshaper': ['driveDb', 'mix', 'outputGainDb'],
  'stereo.imager': ['width', 'decorrelationAmount', 'outputGainDb'],
  'stereo.monoMaker': ['amount'],
};

/** Mirrors the realtime parameter-info catalog used by processor controls. */
export const FAKE_INSERT_PARAM_INFO: Record<
  string,
  Array<{
    name: string;
    id?: number;
    rtSafe: boolean;
    type: 'number' | 'boolean' | 'enum';
    unit?: string;
    min?: number;
    max?: number;
    uiMin?: number;
    uiMax?: number;
    scale?: 'linear' | 'log';
    default?: number | boolean;
    choices?: Array<{ name: string; value: number }>;
  }>
> = {
  'eq.tilt': [
    { name: 'tiltDb', id: 0, rtSafe: true, type: 'number', unit: 'dB', uiMin: -12, uiMax: 12 },
  ],
  'dynamics.compressor': [
    { name: 'thresholdDb', id: 0, rtSafe: true, type: 'number', unit: 'dB', uiMin: -60, uiMax: 0 },
    {
      name: 'ratio',
      id: 1,
      rtSafe: true,
      type: 'number',
      unit: 'ratio',
      min: 1,
      uiMin: 1,
      uiMax: 20,
    },
    {
      name: 'attackMs',
      id: 2,
      rtSafe: true,
      type: 'number',
      unit: 'ms',
      min: 0,
      uiMin: 0.1,
      uiMax: 200,
      scale: 'log',
    },
    {
      name: 'releaseMs',
      id: 3,
      rtSafe: true,
      type: 'number',
      unit: 'ms',
      min: 0,
      uiMin: 0.1,
      uiMax: 2000,
      scale: 'log',
    },
    {
      name: 'kneeDb',
      id: 4,
      rtSafe: true,
      type: 'number',
      unit: 'dB',
      min: 0,
      uiMin: 0,
      uiMax: 24,
    },
    {
      name: 'makeupGainDb',
      id: 5,
      rtSafe: true,
      type: 'number',
      unit: 'dB',
      uiMin: -12,
      uiMax: 24,
    },
    { name: 'autoMakeup', id: 6, rtSafe: true, type: 'boolean', default: false },
    {
      name: 'detector',
      id: 7,
      rtSafe: true,
      type: 'enum',
      default: 1,
      choices: [
        { name: 'peak', value: 0 },
        { name: 'rms', value: 1 },
        { name: 'logRms', value: 2 },
      ],
    },
    { name: 'sidechainHpfEnabled', id: 8, rtSafe: true, type: 'boolean' },
  ],
  'eq.parametric': [
    { name: 'band0.enabled', rtSafe: false, type: 'boolean', default: true },
    {
      name: 'band0.type',
      rtSafe: false,
      type: 'enum',
      default: 0,
      choices: [
        { name: 'peak', value: 0 },
        { name: 'lowShelf', value: 1 },
        { name: 'highShelf', value: 2 },
        { name: 'lowPass', value: 3 },
        { name: 'highPass', value: 4 },
        { name: 'bandPass', value: 5 },
        { name: 'notch', value: 6 },
        { name: 'allPass', value: 9 },
      ],
    },
  ],
  'dynamics.limiter': [
    { name: 'thresholdDb', id: 0, rtSafe: true, type: 'number', unit: 'dB' },
    { name: 'releaseMs', id: 1, rtSafe: true, type: 'number', unit: 'ms' },
    { name: 'lookaheadMs', rtSafe: false, type: 'number', unit: 'ms' },
  ],
  'saturation.softClipper': [
    { name: 'driveDb', id: 0, rtSafe: true, type: 'number', unit: 'dB' },
    { name: 'mix', id: 1, rtSafe: true, type: 'number' },
    { name: 'ceiling', rtSafe: false, type: 'number' },
    {
      name: 'aliasing',
      rtSafe: false,
      type: 'enum',
      default: 0,
      choices: [
        { name: 'none', value: 0 },
        { name: 'adaa1', value: 1 },
        { name: 'oversample4x', value: 3 },
      ],
    },
  ],
};

/** Mastering preset names the fake catalog reports (subset of the real build). */
export const FAKE_MASTERING_PRESETS = [
  'pop',
  'edm',
  'acoustic',
  'hipHop',
  'speech',
  'vinyl',
] as const;

/** Mirrors the libsonare amp preset catalog used by AmpSimEditor tests. */
export const FAKE_AMP_PRESET_CATALOG = [
  {
    index: 0,
    name: 'cleanCombo',
    params: {
      drive: 0.25,
      bassDb: 2,
      midDb: -1,
      trebleDb: 3,
      presenceDb: 1.5,
      inputDb: 0,
      levelDb: 0,
      cab: true,
      ampModel: 'cleanCombo',
      cabModel: 'guitar4x12',
      micModel: 'dynamic',
      power: 0.15,
      sag: 30 / 440,
      nfb: 0.4,
      micAxis: 0.35,
      micDistanceCm: 3,
    },
  },
  {
    index: 1,
    name: 'chimeEdge',
    params: {
      drive: 0.45,
      bassDb: 0,
      midDb: 1.5,
      trebleDb: 3.5,
      presenceDb: 2,
      cab: true,
      ampModel: 'classAChime',
      cabModel: 'guitar4x12',
      micModel: 'condenser',
      power: 0.35,
      sag: 24 / 320,
      nfb: 0,
      micAxis: 0.2,
      micDistanceCm: 4,
    },
  },
  {
    index: 2,
    name: 'classicCrunch',
    params: {
      drive: 0.6,
      bassDb: 0,
      midDb: 0,
      trebleDb: 0,
      presenceDb: 1,
      cab: true,
      ampModel: 'classicCrunch',
      cabModel: 'guitar4x12',
      micModel: 'dynamic',
      power: 0.4,
      sag: 26 / 440,
      nfb: 0.3,
      micAxis: 0.3,
      micDistanceCm: 2.5,
    },
  },
  {
    index: 3,
    name: 'vintageGrind',
    params: {
      drive: 0.62,
      bassDb: 3,
      midDb: 1,
      trebleDb: -2,
      presenceDb: 0,
      cab: true,
      ampModel: 'vintageCombo',
      cabModel: 'guitar4x12',
      micModel: 'dynamic',
      power: 0.65,
      sag: 50 / 350,
      nfb: 0,
      micAxis: 0.45,
      micDistanceCm: 3,
      levelDb: 1,
    },
  },
  {
    index: 4,
    name: 'crunchStack',
    params: {
      drive: 0.7,
      bassDb: -1,
      midDb: 1,
      trebleDb: 3,
      presenceDb: 2,
      cab: true,
      ampModel: 'classicCrunch',
      cabModel: 'guitar4x12',
      micModel: 'dynamic',
      power: 0.6,
      sag: 21.6 / 470,
      nfb: 0.35,
      micAxis: 0.25,
      micDistanceCm: 2.5,
    },
  },
  {
    index: 5,
    name: 'modernLead',
    params: {
      drive: 0.8,
      bassDb: 1,
      midDb: -3,
      trebleDb: 4,
      presenceDb: 3,
      cab: true,
      ampModel: 'modernHiGain',
      cabModel: 'guitar4x12',
      micModel: 'dynamic',
      power: 0.55,
      sag: 20 / 480,
      nfb: 0.45,
      micAxis: 0.2,
      micDistanceCm: 2.5,
      levelDb: -1,
    },
  },
  {
    index: 6,
    name: 'heavyChug',
    params: {
      drive: 0.85,
      bassDb: 5,
      midDb: -6,
      trebleDb: 2,
      presenceDb: 1,
      cab: true,
      ampModel: 'heavyHiGain',
      cabModel: 'guitar4x12',
      micModel: 'dynamic',
      power: 0.7,
      sag: 59.4 / 480,
      nfb: 0.2,
      micAxis: 0.3,
      micDistanceCm: 2.5,
      levelDb: -2,
    },
  },
  {
    index: 7,
    name: 'coldBiasBuzz',
    params: {
      drive: 0.5,
      bassDb: 0,
      midDb: 0,
      trebleDb: 0,
      presenceDb: 0,
      cab: true,
      ampModel: 'classicCrunch',
      cabModel: 'guitar4x12',
      micModel: 'dynamic',
      power: 0.75,
      sag: 20 / 320,
      nfb: 0.15,
      micAxis: 0.4,
      micDistanceCm: 3,
    },
  },
  {
    index: 8,
    name: 'bassDi',
    params: {
      drive: 0.15,
      bassDb: 2,
      midDb: 0,
      trebleDb: 1,
      presenceDb: 0,
      cab: false,
      ampModel: 'cleanCombo',
      cabModel: 'guitar4x12',
      micModel: 'none',
      power: 0.2,
      sag: 15 / 450,
      nfb: 0.3,
      micAxis: 0,
      micDistanceCm: 2.5,
      levelDb: -1,
    },
  },
  {
    index: 9,
    name: 'bassRig',
    params: {
      drive: 0.35,
      bassDb: 3,
      midDb: -1,
      trebleDb: 1,
      presenceDb: 0,
      cab: true,
      ampModel: 'classicCrunch',
      cabModel: 'bass8x10',
      micModel: 'dynamic',
      power: 0.45,
      sag: 21 / 600,
      nfb: 0.25,
      micAxis: 0.5,
      micDistanceCm: 5,
    },
  },
] as const;

/** Builder-side description of an amp param; null reads as absent in the catalog entry. */
type FakeAmpParamSpec = {
  name: string;
  id: number | null;
  rtSafe: boolean;
  type: 'boolean' | 'number' | 'enum' | 'string';
  min: number | null;
  max: number | null;
  default: number | boolean | null;
  unit: string | null;
  choices: Array<{ name: string; value: number }> | null;
  slot: null;
};

type FakeAmpParamInfo = {
  name: string;
  id?: number;
  rtSafe: boolean;
  type: 'boolean' | 'number' | 'enum' | 'string';
  minExclusive: boolean;
  maxExclusive: boolean;
  default?: number | boolean;
  unit?: string;
  choices?: Array<{ name: string; value: number }>;
};

/** Catalog entry for a builder spec: an absent value is omitted, never null. */
function fakeAmpCatalogEntry(spec: FakeAmpParamSpec): FakeAmpParamInfo {
  return {
    name: spec.name,
    ...(spec.id !== null ? { id: spec.id } : {}),
    rtSafe: spec.rtSafe,
    type: spec.type,
    minExclusive: false,
    maxExclusive: false,
    ...(spec.default !== null ? { default: spec.default } : {}),
    ...(spec.unit !== null ? { unit: spec.unit } : {}),
    ...(spec.choices !== null ? { choices: spec.choices } : {}),
  };
}

function fakeAmpNumber(
  name: string,
  id: number | null,
  defaultValue: number,
  unit: string | null = null,
): FakeAmpParamSpec {
  return {
    name,
    id,
    rtSafe: id !== null,
    type: 'number',
    min: null,
    max: null,
    default: defaultValue,
    unit,
    choices: null,
    slot: null,
  };
}

function fakeAmpBoolean(name: string, id: number | null, defaultValue: boolean): FakeAmpParamSpec {
  return {
    name,
    id,
    rtSafe: id !== null,
    type: 'boolean',
    min: null,
    max: null,
    default: defaultValue,
    unit: null,
    choices: null,
    slot: null,
  };
}

function fakeAmpEnum(
  name: string,
  choices: Array<{ name: string; value: number }>,
  defaultValue: number,
): FakeAmpParamSpec {
  return {
    name,
    id: null,
    rtSafe: false,
    type: 'enum',
    min: null,
    max: null,
    default: defaultValue,
    unit: null,
    choices,
    slot: null,
  };
}

const FAKE_AMP_PARAM_SPECS: FakeAmpParamSpec[] = [
  fakeAmpNumber('drive', 0, 0.5),
  fakeAmpNumber('bassDb', 1, 0, 'dB'),
  fakeAmpNumber('midDb', 2, 0, 'dB'),
  fakeAmpNumber('trebleDb', 3, 0, 'dB'),
  fakeAmpNumber('presenceDb', 4, 0, 'dB'),
  fakeAmpNumber('levelDb', 5, 0, 'dB'),
  fakeAmpNumber('power', 6, 0),
  fakeAmpNumber('sag', 7, 0),
  fakeAmpNumber('transformer', 8, 0),
  fakeAmpNumber('nfb', 9, 0),
  fakeAmpNumber('micAxis', 10, 0),
  fakeAmpNumber('micBAxis', 11, 0),
  fakeAmpNumber('micBlend', 12, 0),
  fakeAmpNumber('cone', 13, 0),
  fakeAmpNumber('crossover', 14, 0),
  fakeAmpNumber('biasShift', 15, 0),
  fakeAmpNumber('inputDb', 16, 0, 'dB'),
  fakeAmpEnum(
    'ampModel',
    [
      { name: 'classicCrunch', value: 0 },
      { name: 'cleanCombo', value: 1 },
      { name: 'modernHiGain', value: 2 },
      { name: 'vintageCombo', value: 3 },
      { name: 'classAChime', value: 4 },
      { name: 'heavyHiGain', value: 5 },
    ],
    0,
  ),
  fakeAmpBoolean('cab', null, true),
  fakeAmpBoolean('cabIrDrivers', null, true),
  {
    name: 'cabIrF32Base64',
    id: null,
    rtSafe: false,
    type: 'string',
    min: null,
    max: null,
    default: null,
    unit: null,
    choices: null,
    slot: null,
  },
  fakeAmpBoolean('cabIrGenerate', null, false),
  fakeAmpNumber('cabIrSampleRate', null, 0),
  fakeAmpEnum(
    'cabModel',
    [
      { name: 'guitar4x12', value: 0 },
      { name: 'bass8x10', value: 1 },
    ],
    0,
  ),
  fakeAmpNumber('doppler', null, 0),
  fakeAmpNumber('micBDistanceCm', null, 15),
  fakeAmpBoolean('micBInvert', null, false),
  fakeAmpEnum(
    'micBModel',
    [
      { name: 'none', value: 0 },
      { name: 'dynamic', value: 1 },
      { name: 'ribbon', value: 2 },
      { name: 'condenser', value: 3 },
    ],
    0,
  ),
  fakeAmpNumber('micDistanceCm', null, 2.5),
  fakeAmpEnum(
    'micModel',
    [
      { name: 'none', value: 0 },
      { name: 'dynamic', value: 1 },
      { name: 'ribbon', value: 2 },
      { name: 'condenser', value: 3 },
    ],
    0,
  ),
  fakeAmpEnum(
    'powerTube',
    [
      { name: '6l6', value: 0 },
      { name: 'el34', value: 1 },
      { name: 'el84', value: 2 },
      { name: '6v6', value: 3 },
    ],
    0,
  ),
  fakeAmpNumber('preampStages', null, 2),
  {
    name: 'preset',
    id: null,
    rtSafe: false,
    type: 'string',
    min: null,
    max: null,
    default: null,
    unit: null,
    choices: null,
    slot: null,
  },
  fakeAmpNumber('presetIndex', null, -1),
  fakeAmpEnum(
    'topology',
    [
      { name: 'voiced', value: 0 },
      { name: 'circuit', value: 1 },
    ],
    0,
  ),
];

const FAKE_AMP_PARAM_DEFAULTS: FakeAmpParamInfo[] = FAKE_AMP_PARAM_SPECS.map(fakeAmpCatalogEntry);

/** Mirrors capabilityCatalog().masteringPresets for the fake preset names. */
export function fakeMasteringPresetCatalog() {
  return FAKE_MASTERING_PRESETS.map((name) =>
    name === 'vinyl'
      ? {
          name,
          kind: 'restoration' as const,
        }
      : {
          name,
          kind: 'mastering' as const,
          targetLufs: -14,
          truePeakCeilingDbtp: -1,
          maxLimiterGainReductionDb: 12,
        },
  );
}

/** Mirrors masteringPresetNames for catalog-aware code paths. */
export function fakeMasteringPresetNames(): string[] {
  return [...FAKE_MASTERING_PRESETS];
}

export function fakeMixingScenePresetNames(): string[] {
  return ['vocalReverbSend', 'drumBusSubgroup', 'commentaryDucking'];
}

/** Integrated loudness the streaming-preview fakes report per measurement path. */
export const FAKE_DOWNMIX_LUFS = -13;
export const FAKE_STEREO_LUFS = -7;

type FakeStreamingPlatform = { name: string; targetLufs: number; ceilingDbtp: number };

/** Platform rows the streaming-preview fakes fall back to when given none. */
const FAKE_STREAMING_PLATFORMS = [
  { name: 'Spotify', targetLufs: -14, ceilingDbtp: -1 },
  { name: 'Apple Music', targetLufs: -16, ceilingDbtp: -1 },
  { name: 'YouTube', targetLufs: -14, ceilingDbtp: -1 },
];

/** Builds the report both streaming-preview fakes return, at a given loudness. */
function fakeStreamingPreview(
  platforms: FakeStreamingPlatform[],
  integratedLufs: number,
): { platforms: Array<Record<string, number | string | boolean>> } {
  return {
    platforms: (platforms.length ? platforms : FAKE_STREAMING_PLATFORMS).map((platform) => {
      const normalizationGainDb = platform.targetLufs - integratedLufs;
      return {
        name: platform.name,
        integratedLufs,
        truePeakDbtp: -0.8,
        normalizationGainDb,
        ceilingRisk: -0.8 + normalizationGainDb > platform.ceilingDbtp,
      };
    }),
  };
}

export function fakeMixingScenePresetJson(preset: string): string {
  const scenes: Record<string, unknown> = {
    commentaryDucking: {
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
          muted: false,
          soloed: false,
          sends: [],
          inserts: [
            {
              slot: 'pre',
              processor: 'dynamics.deesser',
              params: { thresholdDb: -24 },
            },
          ],
        },
        { id: 'guest', faderDb: -4, pan: 0.1, muted: false, soloed: false, sends: [], inserts: [] },
        {
          id: 'music-bed',
          faderDb: -18,
          pan: 0,
          muted: false,
          soloed: false,
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
    },
    drumBusSubgroup: {
      version: 1,
      buses: [
        { id: 'master', role: 'master', inserts: [] },
        { id: 'drum-bus', role: 'subgroup', inserts: [] },
      ],
      connections: [
        { source: 'kick', destination: 'drum-bus' },
        { source: 'snare', destination: 'drum-bus' },
        { source: 'drum-bus', destination: 'drum-bus-return' },
        { source: 'drum-bus-return', destination: 'master' },
      ],
      strips: [
        { id: 'kick', faderDb: -3, pan: 0, muted: false, soloed: false, sends: [], inserts: [] },
        { id: 'snare', faderDb: -3, pan: 0, muted: false, soloed: false, sends: [], inserts: [] },
        {
          id: 'drum-bus-return',
          faderDb: -2,
          pan: 0,
          muted: false,
          soloed: false,
          sends: [],
          inserts: [
            {
              slot: 'pre',
              processor: 'dynamics.parallelComp',
              params: { mix: 0.35 },
            },
          ],
        },
      ],
      vcaGroups: [{ id: 'drums', gainDb: 0, members: ['kick', 'snare'] }],
    },
    vocalReverbSend: {
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
          muted: false,
          soloed: false,
          sends: [{ destinationBusId: 'vocal-verb', sendDb: -14, timing: 'post' }],
          inserts: [],
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
    },
  };
  const scene = scenes[preset];
  if (!scene) throw new RangeError(`Unknown mixer scene preset: ${preset}`);
  return JSON.stringify(scene);
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
export function fakeMeteringPeakDb(
  input: Float32Array | { samples: Float32Array; sampleRate: number },
  _sampleRate = 48000,
): number {
  const peak = fakePeak(input instanceof Float32Array ? input : input.samples);
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

/**
 * Mirrors meteringTruePeakDbtp's shape; the fake skips oversampling and
 * reports the plain sample peak.
 */
export function fakeMeteringTruePeakDbtp(
  input: Float32Array | { samples: Float32Array; sampleRate: number; oversampleFactor?: number },
  _sampleRate = 48000,
  _options: { oversampleFactor?: number } = {},
): number {
  return fakeMeteringPeakDb(input);
}

/**
 * Mirrors meteringDetectClipping: contiguous runs of samples at or above the
 * threshold, with the same defaults as the real detector (0.999 linear, runs
 * of one sample and up) as measured against the shipped wasm.
 */
export function fakeMeteringDetectClipping(
  samples: Float32Array,
  _sampleRate = 48000,
  options: { thresholdDb?: number; minRegionSamples?: number } = {},
): {
  clippedSamples: number;
  clippedRatio: number;
  maxClippedPeak: number;
  regions: Array<{ startSample: number; endSample: number; length: number; peak: number }>;
} {
  const threshold = options.thresholdDb === undefined ? 0.999 : 10 ** (options.thresholdDb / 20);
  const minRegionSamples = options.minRegionSamples ?? 1;
  const regions: Array<{ startSample: number; endSample: number; length: number; peak: number }> =
    [];
  let start = -1;
  let peak = 0;
  const close = (end: number): void => {
    if (start >= 0 && end - start >= minRegionSamples) {
      regions.push({ startSample: start, endSample: end, length: end - start, peak });
    }
    start = -1;
    peak = 0;
  };
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude >= threshold) {
      if (start < 0) start = i;
      if (magnitude > peak) peak = magnitude;
    } else {
      close(i);
    }
  }
  close(samples.length);
  const clippedSamples = regions.reduce((total, region) => total + region.length, 0);
  return {
    clippedSamples,
    clippedRatio: samples.length > 0 ? clippedSamples / samples.length : 0,
    maxClippedPeak: regions.reduce((max, region) => Math.max(max, region.peak), 0),
    regions,
  };
}

/**
 * Mirrors the lufs() result shape with a deterministic energy-based estimate
 * (no K-weighting/gating; integratedLufs = -0.691 + 10*log10(mean square)).
 */
export function fakeLufs(
  input: Float32Array | { samples: Float32Array; sampleRate: number },
  _sampleRate = 48000,
): {
  integratedLufs: number;
  momentaryLufs: number;
  shortTermLufs: number;
  maxMomentaryLufs: number;
  maxShortTermLufs: number;
  loudnessRangeLu: number;
} {
  const samples = input instanceof Float32Array ? input : input.samples;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const meanSquare = samples.length > 0 ? sum / samples.length : 0;
  const loudness = meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : Number.NEGATIVE_INFINITY;
  return {
    integratedLufs: loudness,
    momentaryLufs: loudness,
    shortTermLufs: loudness,
    maxMomentaryLufs: loudness,
    maxShortTermLufs: loudness,
    loudnessRangeLu: 0,
  };
}

/**
 * Mirrors lufsMultichannel(): channel-weighted integrated loudness from planar
 * channels (no K-weighting/gating, all channel weights 1.0, so it sums the
 * per-channel mean square). For one channel this equals fakeLufs; for
 * dual-mono stereo it reads ~+3 LU as BS.1770 requires.
 */
export function fakeLufsMultichannel(request: { channels: Float32Array[]; sampleRate: number }): {
  integratedLufs: number;
  momentaryLufs: number;
  shortTermLufs: number;
  maxMomentaryLufs: number;
  maxShortTermLufs: number;
  loudnessRangeLu: number;
} {
  const { channels } = request;
  let total = 0;
  for (const channel of channels) {
    let sum = 0;
    for (const sample of channel) sum += sample * sample;
    total += channel.length > 0 ? sum / channel.length : 0;
  }
  const loudness = total > 0 ? -0.691 + 10 * Math.log10(total) : Number.NEGATIVE_INFINITY;
  return {
    integratedLufs: loudness,
    momentaryLufs: loudness,
    shortTermLufs: loudness,
    maxMomentaryLufs: loudness,
    maxShortTermLufs: loudness,
    loudnessRangeLu: 0,
  };
}

/**
 * Mirrors masterAudioStereo's result envelope; the fake applies no DSP and
 * copies the input through (preset chains need the real wasm).
 */
export function fakeMasterAudioStereo(request: {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  preset?: string;
  overrides?: Record<string, unknown>;
}): {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  inputLufs: number;
  outputLufs: number;
  appliedGainDb: number;
  stages: string[];
} {
  return {
    left: new Float32Array(request.left),
    right: new Float32Array(request.right),
    sampleRate: request.sampleRate,
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
export function createFakeWasmModule(): typeof import('@libraz/libsonare') {
  return {
    Project: FakeProject,
    midiNoteOn,
    midiNoteOff,
    midiProgram,
    midiCc,
    midiPolyPressure,
    midiChannelPressure,
    midiPitchBend,
    midiBankProgram,
    gmInstrumentName,
    gmProgramForName,
    gmFamilyName,
    gmFamilyFirstProgram,
    gm2InstrumentName,
    scalePitchClassEnabled,
    scaleQuantizeMidi,
    init: async () => {},
    synthPresetNames: fakeSynthPresetNames,
    synthPresetPatch: fakeSynthPresetPatch,
    synthGsVariationIsVoicedApart: (bank: number, program: number) => bank === 1 && program === 24,
    synthGsDrumKitName: (program: number) =>
      program === 0 ? 'Standard Kit' : program === 8 ? 'Room Kit' : null,
    synthGsDrumKitIsVoicedApart: (program: number) => program === 8,
    masteringInsertNames: () => Object.keys(FAKE_INSERT_PARAMS),
    // The core exports no runtime list of every processor; its realtime insert
    // names plus the fake's own catalog entries stand in for it.
    masteringProcessorNames: () => [
      ...new Set<string>([...MASTERING_INSERT_NAMES, ...Object.keys(FAKE_INSERT_PARAMS)]),
    ],
    masteringProcessorCatalog: () =>
      Object.keys(FAKE_INSERT_PARAMS).map((id) => ({
        id,
        kind: 'realtime',
        realtimeInsertable: true,
        stereoOnly: id === 'modulation.rotary' || id === 'stereo.imager',
        latencySamples: 0,
        tailSamples: 0,
        channelPolicy: 'multichannel',
        category: 'other',
        causal: true,
        params: FAKE_INSERT_PARAM_INFO[id] ?? [],
        slots: [],
      })),
    // A lookahead is the only build-time latency the fake inserts report.
    masteringInsertTiming: (request: {
      insert: string;
      params?: Record<string, number | boolean>;
      sampleRate: number;
    }) => ({
      latencySamples:
        typeof request.params?.lookaheadMs === 'number'
          ? Math.round((request.params.lookaheadMs * request.sampleRate) / 1000)
          : 0,
      tailSamples: 0,
    }),
    masteringInsertParamNames: (name: string) => FAKE_INSERT_PARAMS[name] ?? [],
    masteringInsertParamInfo: (request: { insert: string; sampleRate?: number }) =>
      request.insert === 'saturation.ampSim'
        ? [...FAKE_AMP_PARAM_DEFAULTS]
        : (FAKE_INSERT_PARAM_INFO[request.insert] ?? []),
    masteringAmpPresetCatalog: () =>
      FAKE_AMP_PRESET_CATALOG.map((entry) => ({
        index: entry.index,
        name: entry.name,
        params: { inputDb: 0, levelDb: 0, ...entry.params },
      })),
    masteringPresetNames: fakeMasteringPresetNames,
    capabilityCatalog: () => ({ masteringPresets: fakeMasteringPresetCatalog() }),
    masteringPresetParams: () => ({ loudness: { targetLufs: -12, ceilingDbtp: -1 } }),
    mixingScenePresetNames: fakeMixingScenePresetNames,
    mixingScenePreset: (name: string) => JSON.parse(fakeMixingScenePresetJson(name)),
    masteringStreamingPreview: (
      first: Float32Array | { platforms?: FakeStreamingPlatform[] },
      _sampleRate = 48000,
      options: { platforms?: FakeStreamingPlatform[] } = {},
    ) =>
      fakeStreamingPreview(
        (first instanceof Float32Array ? options : first).platforms ?? [],
        FAKE_DOWNMIX_LUFS,
      ),
    // BS.1770 channel summing reads hotter than the mono downmix the caller
    // would otherwise have to build, which is the reason the stereo entry
    // point exists; the fake reproduces that offset so callers can tell the
    // two paths apart.
    masteringStreamingPreviewStereo: (request: {
      left: Float32Array;
      right: Float32Array;
      sampleRate: number;
      platforms?: FakeStreamingPlatform[];
    }) => fakeStreamingPreview(request.platforms ?? [], FAKE_STEREO_LUFS),
    masteringAnalyzePair: (request: { analysis: string }) => {
      if (request.analysis === 'match.matchEqCurve') {
        return { frequencies: [100, 1000], gainDb: [1, -2] };
      }
      if (request.analysis === 'match.tonalBalance') {
        return {
          bands: [{ lowHz: 100, highHz: 1000, sourceDb: -12, referenceDb: -14, deviationDb: 2 }],
        };
      }
      return { sourceLufs: -12, referenceLufs: -14, gainToMatchDb: -2 };
    },
    masteringAnalyzeStereo: (_request: {
      analysis: string;
      left: Float32Array;
      right: Float32Array;
      sampleRate: number;
    }) => ({
      correlation: 0.42,
      width: 0.8,
      monoPeak: -3.2,
      sideRms: 0.1,
      likelyMonoCompatible: true,
    }),
    // Pass-through one-shot stereo processor: copies the input unchanged.
    masteringApplyProcessorStereo: (request: {
      processor: string;
      left: Float32Array;
      right: Float32Array;
      sampleRate: number;
      params?: Record<string, number | boolean>;
    }) => ({
      left: new Float32Array(request.left),
      right: new Float32Array(request.right),
      sampleRate: request.sampleRate,
      inputLufs: 0,
      outputLufs: 0,
      appliedGainDb: 0,
      latencySamples: 0,
      loudnessTargetLimited: false,
      nonFiniteSubstitutionCount: 0,
    }),
    StreamingEqualizer: FakeStreamingEqualizer,
    masterAudioStereo: fakeMasterAudioStereo,
    meteringPeakDb: fakeMeteringPeakDb,
    meteringTruePeakDbtp: fakeMeteringTruePeakDbtp,
    meteringDetectClipping: fakeMeteringDetectClipping,
    lufs: fakeLufs,
    lufsMultichannel: fakeLufsMultichannel,
  } as unknown as typeof import('@libraz/libsonare');
}
