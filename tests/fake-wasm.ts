/**
 * Shared in-memory stand-in for the libsonare wasm module, used by specs that
 * exercise the project store/commands without real wasm.
 *
 * The fake mimics the behaviors the production code depends on:
 * - toJson() emits the real snake_case document shape (tracks, clips,
 *   midi_content, tempo_segments, time_signatures, markers).
 * - The undo history granularity matches the real binding: most edits push
 *   one history entry; addClip pushes two (source registration + clip add)
 *   and addMidiClip pushes three (source + track + clip). setClipSource,
 *   setClipFade and setAudioSourceMetadata push one entry each.
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
  warp_ref_id?: number;
  warp_mode?: number;
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
  kind?: number;
  key_fifths?: number;
  key_minor?: boolean;
}

/** One chord stored in the annotation stream, in the toJson() snake_case shape. */
interface FakeAnnotationChord {
  start_ppq: number;
  end_ppq: number;
  root_pc: number;
  quality: number;
  slash_bass_pc: number;
  roman_numeral: string;
  extensions: number[];
  modulation_boundary: boolean;
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
    const w = event.data0 >>> 0;
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
  private sampleRate = 48000;
  private state: FakeState = {
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

  static midiCc(
    ppq: number,
    group: number,
    channel: number,
    controller: number,
    value: number,
  ): FakeEvent {
    return { ppq, data0: pack(group, 0xb, channel, controller, value), data1: 0 };
  }

  static midiPolyPressure(
    ppq: number,
    group: number,
    channel: number,
    note: number,
    pressure: number,
  ): FakeEvent {
    return { ppq, data0: pack(group, 0xa, channel, note, pressure), data1: 0 };
  }

  static midiChannelPressure(
    ppq: number,
    group: number,
    channel: number,
    pressure: number,
  ): FakeEvent {
    return { ppq, data0: pack(group, 0xd, channel, pressure, 0), data1: 0 };
  }

  static midiPitchBend(ppq: number, group: number, channel: number, bend: number): FakeEvent {
    return { ppq, data0: pack(group, 0xe, channel, bend & 0x7f, (bend >> 7) & 0x7f), data1: 0 };
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

  static gmInstrumentName(program: number): string | null {
    return FAKE_GM_INSTRUMENTS[program] ?? null;
  }

  static gmProgramForName(name: string): number {
    return FAKE_GM_INSTRUMENTS.findIndex((entry) => entry.toLowerCase() === name.toLowerCase());
  }

  static gmFamilyName(family: number): string | null {
    return FAKE_GM_FAMILIES[family] ?? null;
  }

  static gmFamilyFirstProgram(family: number): number {
    return family >= 0 && family < FAKE_GM_FAMILIES.length ? family * 8 : -1;
  }

  static gm2InstrumentName(bankLsb: number, program: number): string | null {
    if (bankLsb === 1 && program === 24) return 'Ukulele';
    if (bankLsb === 1 && program === 25) return '12-String Guitar';
    return FakeProject.gmInstrumentName(program);
  }

  /** Pushes one history entry, then applies the mutation. */
  private edit<T>(mutate: () => T): T {
    this.history.push(cloneState(this.state));
    while (this.history.length > this.maxUndoDepth) this.history.shift();
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

  setAssistSidecar(
    moduleId: string,
    schemaVersion: number,
    targetTrackId: number,
    regionStartPpq: number,
    regionEndPpq: number,
    payload: Uint8Array,
  ): void {
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

  assistSidecarCount(): number {
    return this.state.assistSidecars.length;
  }

  getAssistSidecar(index: number): FakeSidecar {
    const sidecar = this.state.assistSidecars[index];
    if (!sidecar) throw new RangeError(`Unknown assist sidecar index ${index}`);
    return { ...sidecar, payload: sidecar.payload.slice() };
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

  /** Replaces an audio source's metadata strings (one history entry). */
  setAudioSourceMetadata(sourceId: number, contentHash: string, externalStemRole: string): void {
    this.edit(() => {
      const source = this.state.sources.get(sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      source.contentHash = contentHash;
      source.externalStemRole = externalStemRole;
    });
  }

  /** Registered source by zero-based registration index (source ids are 1-based). */
  sourceByIndex(index: number): {
    id: number;
    nameOrUri: string;
    contentHash: string;
    externalStemRole: string;
  } {
    const source = this.state.sources.get(index + 1);
    if (!source) throw new RangeError(`Unknown source index ${index}`);
    return {
      id: source.id,
      nameOrUri: source.uri ?? '',
      contentHash: source.contentHash ?? '',
      externalStemRole: source.externalStemRole ?? '',
    };
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
    const source = this.requireClip(clipId);
    if (source.loop_mode !== 0) {
      throw new Error('Turn Loop off before splitting this clip.');
    }
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

  setClipWarpRef(clipId: number, warpRefId: number): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      if (warpRefId <= 0) delete clip.warp_ref_id;
      else clip.warp_ref_id = warpRefId;
    });
  }

  setClipWarpMode(clipId: number, mode: string | number): void {
    this.edit(() => {
      const clip = this.requireClip(clipId);
      const value =
        mode === 'repitch' || mode === 1 ? 1 : mode === 'tempo-sync' || mode === 2 ? 2 : 0;
      if (value === 0) delete clip.warp_mode;
      else clip.warp_mode = value;
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
        events.map((e) => ({ ppq: e.ppq, data0: e.data0, data1: e.data1 ?? 0 })),
      );
    });
  }

  /**
   * Applies a MIDI-FX transform to a clip's stored events, mirroring the real
   * engine's verified flat-config semantics (transpose, grid quantize, velocity
   * scale/offset/gamma, bounded humanize, chord harmonize) as one undoable
   * edit. Humanize uses a deterministic index-based jitter so tests stay stable.
   *
   * Both call forms of the real binding are accepted. The request form with
   * `withSourceIndex` answers with per-output-event provenance in the input
   * event's index space, as measured against the real engine: every event a
   * chord fan-out produces reports the same origin, and the transform's own
   * reordering is reflected in the order of the returned array.
   */
  bakeMidiFx(
    clipIdOrRequest: number | { clipId: number; configJson: string; withSourceIndex?: boolean },
    configJsonArg?: string,
  ): { sourceIndex?: Int32Array } {
    const request =
      typeof clipIdOrRequest === 'number'
        ? { clipId: clipIdOrRequest, configJson: configJsonArg ?? '{}', withSourceIndex: false }
        : clipIdOrRequest;
    const clipId = request.clipId;
    const cfg = JSON.parse(request.configJson) as Record<string, number | number[]>;
    const transpose = typeof cfg.transpose_semitones === 'number' ? cfg.transpose_semitones : 0;
    const qPpq = typeof cfg.quantize_ppq === 'number' ? cfg.quantize_ppq : 0;
    const qStr = typeof cfg.quantize_strength === 'number' ? cfg.quantize_strength : 0;
    const vScale = typeof cfg.velocity_scale === 'number' ? cfg.velocity_scale : 1;
    const vOffset = typeof cfg.velocity_offset === 'number' ? cfg.velocity_offset : 0;
    const vGamma = typeof cfg.velocity_gamma === 'number' ? cfg.velocity_gamma : 1;
    const hPpq = typeof cfg.humanize_ppq === 'number' ? cfg.humanize_ppq : 0;
    const hVel = typeof cfg.humanize_velocity === 'number' ? cfg.humanize_velocity : 0;
    const chord = Array.isArray(cfg.chord_intervals) ? cfg.chord_intervals : null;
    const clampU7 = (v: number) => Math.min(127, Math.max(0, Math.round(v)));
    const out: Array<{ event: FakeEvent; source: number }> = [];
    this.edit(() => {
      this.requireClip(clipId);
      const source = this.state.midi.get(clipId) ?? [];
      const timeShift = midiFxTimeShifts(source, hPpq, qPpq, qStr);
      source.forEach((event, index) => {
        const w = event.data0 >>> 0;
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
            event: { ppq, data0: pack(group, status, channel, n, value), data1: event.data1 },
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
  previewMidiFxCount(request: { clipId: number; configJson: string }): number {
    const cfg = JSON.parse(request.configJson) as Record<string, number | number[]>;
    const chord = Array.isArray(cfg.chord_intervals) ? cfg.chord_intervals : null;
    const voices = chord && chord.length > 0 ? chord.length : 1;
    const source = this.state.midi.get(request.clipId) ?? [];
    return source.reduce((total, event) => {
      const status = ((event.data0 >>> 0) >>> 20) & 0xf;
      const isNote = status === 0x8 || status === 0x9;
      return total + (isNote ? voices : 1);
    }, 0);
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

  setMarkerEx(marker: {
    id?: number;
    ppq: number;
    name: string;
    kind?: number;
    keyFifths?: number;
    keyMinor?: boolean;
  }): number {
    return this.edit(() => {
      const id = marker.id ?? 0;
      const entry: FakeMarker = {
        id: id === 0 ? this.nextMarkerId++ : id,
        ppq: marker.ppq,
        name: marker.name,
        kind: marker.kind,
        key_fifths: marker.keyFifths,
        key_minor: marker.keyMinor,
      };
      const existing = id === 0 ? undefined : this.state.markers.find((m) => m.id === id);
      if (existing) Object.assign(existing, entry);
      else this.state.markers.push(entry);
      return entry.id;
    });
  }

  /**
   * Replaces the chord-symbol annotation stream (one undoable edit), mirroring
   * the real Project's field clamping: the 255 "no pitch class" sentinel is
   * preserved, omitted extensions become an empty array, and the stored form
   * uses the snake_case shape that toJson() emits.
   */
  annotateChords(
    chords: ReadonlyArray<{
      startPpq: number;
      endPpq: number;
      rootPc?: number;
      quality?: number;
      slashBassPc?: number;
      extensions?: ReadonlyArray<number>;
      romanNumeral?: string;
    }>,
  ): void {
    this.edit(() => {
      this.state.chords = chords.map((c) => ({
        start_ppq: c.startPpq,
        end_ppq: c.endPpq,
        root_pc: c.rootPc ?? 255,
        quality: c.quality ?? 0,
        slash_bass_pc: c.slashBassPc ?? 255,
        roman_numeral: c.romanNumeral ?? '',
        extensions: c.extensions ? [...c.extensions] : [],
        modulation_boundary: false,
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
        const status = (event.data0 >>> 20) & 0xf;
        const channel = (event.data0 >>> 16) & 0xf;
        const data1 = (event.data0 >>> 8) & 0xff;
        const data2 = event.data0 & 0xff;
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
            presetName:
              backend === 'sf2'
                ? `SF2 ${bank}:${program}`
                : (FakeProject.gmInstrumentName(program) ?? `Program ${program}`),
          });
        }
      }
    }
    return manifest;
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
      warp_maps: [...this.state.warpMaps.values()].map((map) => ({
        id: map.id,
        name: map.name,
        anchors: map.anchors.map((anchor) => ({ ...anchor })),
      })),
      markers: this.state.markers.map((m) => ({ ...m })),
      annotation: { chords: this.state.chords.map((c) => ({ ...c })) },
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
  'saw-lead',
  'square-lead',
  'e-piano',
  'acoustic-piano',
  'warm-pad',
  'sub-bass',
  'pluck',
  'organ',
  'brass',
  'pipe-organ',
  'bowed-string',
  'reed',
  'flute',
  'electric-guitar',
  'drum-kit',
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
    id: number;
    rtSafe: boolean;
    type: 'number' | 'boolean' | 'enum';
    unit?: string;
  }>
> = {
  'dynamics.compressor': [
    { name: 'thresholdDb', id: 0, rtSafe: true, type: 'number', unit: 'dB' },
    { name: 'ratio', id: 1, rtSafe: true, type: 'number' },
    { name: 'attackMs', id: 2, rtSafe: true, type: 'number', unit: 'ms' },
    { name: 'releaseMs', id: 3, rtSafe: true, type: 'number', unit: 'ms' },
    { name: 'kneeDb', id: 4, rtSafe: true, type: 'number', unit: 'dB' },
    { name: 'makeupGainDb', id: 5, rtSafe: true, type: 'number', unit: 'dB' },
    { name: 'autoMakeup', id: 6, rtSafe: true, type: 'number' },
    { name: 'detector', id: 7, rtSafe: true, type: 'number' },
    { name: 'sidechainHpfEnabled', id: 8, rtSafe: true, type: 'boolean' },
  ],
};

/** Mastering preset names the fake catalog reports (subset of the real build). */
export const FAKE_MASTERING_PRESETS = ['pop', 'edm', 'acoustic', 'hipHop', 'speech'] as const;

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

/** Platform rows the streaming-preview fakes fall back to when given none. */
const FAKE_STREAMING_PLATFORMS = [
  { name: 'Spotify', targetLufs: -14, ceilingDb: -1 },
  { name: 'Apple Music', targetLufs: -16, ceilingDb: -1 },
  { name: 'YouTube', targetLufs: -14, ceilingDb: -1 },
];

/** Builds the report both streaming-preview fakes return, at a given loudness. */
function fakeStreamingPreviewJson(
  platforms: Array<{ name: string; targetLufs: number; ceilingDb: number }>,
  integratedLufs: number,
): string {
  return JSON.stringify({
    platforms: (platforms.length ? platforms : FAKE_STREAMING_PLATFORMS).map((platform) => {
      const normalizationGainDb = platform.targetLufs - integratedLufs;
      return {
        name: platform.name,
        integratedLufs,
        truePeakDb: -0.8,
        normalizationGainDb,
        ceilingRisk: -0.8 + normalizationGainDb > platform.ceilingDb,
      };
    }),
  });
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
              params: JSON.stringify({ thresholdDb: -24 }),
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
              params: JSON.stringify({ rangeDb: 18 }),
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
              params: JSON.stringify({ mix: 0.35 }),
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
              params: JSON.stringify({ width: 1.35 }),
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
 * Mirrors meteringDetectClipping: contiguous runs of samples at or above the
 * threshold, with the same defaults as the real detector (0.999 linear, runs
 * of one sample and up) as measured against the shipped wasm.
 */
export function fakeMeteringDetectClipping(
  samples: Float32Array,
  _sampleRate = 48000,
  options: { threshold?: number; minRegionSamples?: number } = {},
): {
  clippedSamples: number;
  clippingRatio: number;
  maxClippedPeak: number;
  regions: Array<{ startSample: number; endSample: number; length: number; peak: number }>;
} {
  const threshold = options.threshold ?? 0.999;
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
    clippingRatio: samples.length > 0 ? clippedSamples / samples.length : 0,
    maxClippedPeak: regions.reduce((max, region) => Math.max(max, region.peak), 0),
    regions,
  };
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
 * Mirrors lufsInterleaved(): channel-weighted integrated loudness from an
 * interleaved buffer (no K-weighting/gating, all channel weights 1.0, so it
 * sums the per-channel mean square). For one channel this equals fakeLufs;
 * for dual-mono stereo it reads ~+3 LU as BS.1770 requires.
 */
export function fakeLufsInterleaved(
  samples: Float32Array,
  channels: number,
  _sampleRate = 48000,
): { integratedLufs: number; momentaryLufs: number; shortTermLufs: number; loudnessRange: number } {
  const frames = channels > 0 ? Math.floor(samples.length / channels) : 0;
  let total = 0;
  for (let c = 0; c < channels; c++) {
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      const sample = samples[i * channels + c];
      sum += sample * sample;
    }
    total += frames > 0 ? sum / frames : 0;
  }
  const loudness = total > 0 ? -0.691 + 10 * Math.log10(total) : Number.NEGATIVE_INFINITY;
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
    scaleQuantizeMidi,
    init: async () => {},
    synthPresetNames: fakeSynthPresetNames,
    synthPresetPatch: fakeSynthPresetPatch,
    masteringInsertNames: () => Object.keys(FAKE_INSERT_PARAMS),
    masteringProcessorCatalog: () =>
      Object.keys(FAKE_INSERT_PARAMS).map((id) => ({
        id,
        kind: 'realtime',
        realtimeInsertable: true,
        stereoOnly: id === 'modulation.rotary' || id === 'stereo.imager',
        latencySamples: 0,
      })),
    masteringInsertParamNames: (name: string) => FAKE_INSERT_PARAMS[name] ?? [],
    masteringInsertParamInfo: (name: string) => FAKE_INSERT_PARAM_INFO[name] ?? [],
    masteringPresetNames: fakeMasteringPresetNames,
    mixingScenePresetNames: fakeMixingScenePresetNames,
    mixingScenePresetJson: fakeMixingScenePresetJson,
    masteringStreamingPreview: (
      _samples: Float32Array,
      _sampleRate = 48000,
      platforms: Array<{ name: string; targetLufs: number; ceilingDb: number }> = [],
    ) => fakeStreamingPreviewJson(platforms, FAKE_DOWNMIX_LUFS),
    // BS.1770 channel summing reads hotter than the mono downmix the caller
    // would otherwise have to build, which is the reason the stereo entry
    // point exists; the fake reproduces that offset so callers can tell the
    // two paths apart.
    masteringStreamingPreviewStereo: (request: {
      left: Float32Array;
      right: Float32Array;
      sampleRate?: number;
      platforms?: Array<{ name: string; targetLufs: number; ceilingDb: number }>;
    }) => fakeStreamingPreviewJson(request.platforms ?? [], FAKE_STEREO_LUFS),
    masteringPairAnalyze: (name: string) => {
      if (name === 'match.matchEqCurve') {
        return JSON.stringify({ frequencies: [100, 1000], gainDb: [1, -2] });
      }
      if (name === 'match.tonalBalance') {
        return JSON.stringify({
          bands: [{ lowHz: 100, highHz: 1000, sourceDb: -12, referenceDb: -14, deviationDb: 2 }],
        });
      }
      return JSON.stringify({ sourceLufs: -12, referenceLufs: -14, gainToMatchDb: -2 });
    },
    masteringStereoAnalyze: (
      _analysisName: string,
      _left: Float32Array,
      _right: Float32Array,
      _sampleRate = 48000,
    ) =>
      JSON.stringify({
        correlation: 0.42,
        monoCompatWidth: 0.8,
        monoCompatPeak: -3.2,
        likelyMonoCompatible: true,
      }),
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
    meteringDetectClipping: fakeMeteringDetectClipping,
    lufs: fakeLufs,
    lufsInterleaved: fakeLufsInterleaved,
  } as unknown as typeof import('@/wasm/index.js');
}
