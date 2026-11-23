import { clampInt } from '@/lib/math';
import { defaultName } from '@/project/default-names';
import type { DocumentClip } from '@/project/serialization';
import type { NormalizedTempoMap } from '@/project/tempo-map';
import {
  audioContentOriginFromPlayStartSeconds,
  audioContentOriginPpq,
  audioContentSecondsToPpq,
  audioFadeSecondsToPpq,
} from './audio-time';
import { DEFAULT_IMPORTED_CLIP_LENGTH_PPQ, MIN_IMPORTED_LENGTH_PPQ } from './format';
import type { DawprojectImportLoss } from './import-loss';
import { readMidiExpressionPoints } from './midi-expression-import';
import { boolAttr, children, numberAttr } from './xml-read';

export interface FlattenedClipPlacement {
  startPpq: number;
  lengthPpq: number;
  /** Visible start in this clip's content coordinate. */
  contentWindowStart: number;
  contentTimeUnit: string;
  /** Nearest name up the placement chain; absent when every level is unnamed. */
  name?: string;
  loopEnabled?: boolean;
  loopLengthPpq?: number;
  fadeElement: Element;
}

export interface FlattenedClipLeaf {
  element: Element;
  placement: FlattenedClipPlacement;
}

function normalizedVelocity(value: number | null): number {
  if (value === null) return 96;
  return clampInt(value * 127, 1, 127);
}

/** The content-window attributes of a clip; the only place they are read. */
function readContentWindow(clip: Element): {
  playStart: number | null;
  loopStart: number | null;
  loopEnd: number | null;
} {
  return {
    playStart: numberAttr(clip, 'playStart'),
    loopStart: numberAttr(clip, 'loopStart'),
    loopEnd: numberAttr(clip, 'loopEnd'),
  };
}

/** Tolerance when comparing a loop start with the play start. */
const LOOP_START_EPSILON = 1e-6;

/**
 * Sonare loops [sourceOffset, sourceOffset + loopLength). A loop that begins
 * after the play start is aligned by starting the source at the loop start; the
 * pre-roll before it cannot be kept, so the clip is reported.
 */
function alignLoopStart(
  windowStart: number,
  loopStart: number | null,
  loopEnd: number | null,
  clipName: string,
  losses: DawprojectImportLoss[],
): number {
  if (
    loopStart === null ||
    loopEnd === null ||
    !(loopEnd > loopStart) ||
    Math.abs(loopStart - windowStart) < LOOP_START_EPSILON
  ) {
    return windowStart;
  }
  losses.push({ kind: 'unsupported-nested-clip', clipName, reason: 'loop-start-offset' });
  return loopStart > windowStart ? loopStart : windowStart;
}

/** Moves expression points from content time to clip-window time, dropping those before the window. */
function shiftExpressionLanes(clip: DocumentClip, offsetPpq: number): void {
  if (offsetPpq === 0) return;
  const shift = <T extends { points: Array<{ ppq: number }> }>(lanes: T[] | undefined): void => {
    for (const lane of lanes ?? []) {
      lane.points = lane.points
        .map((point) => ({ ...point, ppq: point.ppq - offsetPpq }))
        .filter((point) => point.ppq >= 0);
    }
  };
  shift(clip.ccLanes);
  shift(clip.pitchBendLanes);
  shift(clip.programChangeLanes);
  shift(clip.channelPressureLanes);
  shift(clip.polyPressureLanes);
}

function clipLoopState(
  clip: Element,
  inherited?: Pick<FlattenedClipPlacement, 'loopEnabled' | 'loopLengthPpq'>,
): Pick<FlattenedClipPlacement, 'loopEnabled' | 'loopLengthPpq'> {
  const contentTimeUnit = clip.getAttribute('contentTimeUnit')?.trim() || 'beats';
  const { loopStart, loopEnd } = readContentWindow(clip);
  if (
    contentTimeUnit === 'beats' &&
    loopStart !== null &&
    loopEnd !== null &&
    loopEnd > loopStart
  ) {
    return { loopEnabled: true, loopLengthPpq: loopEnd - loopStart };
  }
  return inherited
    ? {
        ...(inherited.loopEnabled !== undefined ? { loopEnabled: inherited.loopEnabled } : {}),
        ...(inherited.loopLengthPpq !== undefined
          ? { loopLengthPpq: inherited.loopLengthPpq }
          : {}),
      }
    : {};
}

/** XSD boolean `enable` defaults to true when absent. */
function clipEnabled(clip: Element): boolean {
  const value = clip.getAttribute('enable');
  return value === null || boolAttr(clip, 'enable');
}

/**
 * Flattens nested DAWproject clip timelines by recursively composing each
 * parent's visible content window with its child event placement. DAWproject
 * permits this structure (DAWs commonly emit an outer arrangement clip
 * containing one inner audio event); Sonare stores the resulting audible
 * events as ordinary flat clips.
 */
export function flattenClipLeaves(
  root: Element,
  losses: DawprojectImportLoss[],
): FlattenedClipLeaf[] {
  if (!clipEnabled(root)) {
    losses.push({
      kind: 'disabled-clip',
      clipName: root.getAttribute('name') || defaultName('lossClip'),
    });
    return [];
  }
  const rootStart = numberAttr(root, 'time') ?? 0;
  const rootLength = Math.max(
    MIN_IMPORTED_LENGTH_PPQ,
    numberAttr(root, 'duration') ?? DEFAULT_IMPORTED_CLIP_LENGTH_PPQ,
  );
  const rootName = root.getAttribute('name') || undefined;
  const rootUnit = root.getAttribute('contentTimeUnit')?.trim() || 'beats';
  const rootLoop = clipLoopState(root);
  const initial: FlattenedClipPlacement = {
    startPpq: rootStart,
    lengthPpq: rootLength,
    contentWindowStart: readContentWindow(root).playStart ?? 0,
    contentTimeUnit: rootUnit,
    name: rootName,
    ...rootLoop,
    fadeElement: root,
  };

  const walk = (clip: Element, placement: FlattenedClipPlacement): FlattenedClipLeaf[] => {
    const nested = children(children(clip, 'Clips')[0], 'Clip');
    if (nested.length === 0) {
      // A content-less audio Clip is still a valid placement placeholder when
      // its external media is unavailable, so it must survive for relinking.
      return [{ element: clip, placement }];
    }
    if (placement.contentTimeUnit !== 'beats') {
      losses.push({
        kind: 'unsupported-nested-clip',
        clipName: placement.name ?? defaultName('lossClip'),
        reason: 'mixed-time-units',
      });
      return [];
    }
    if (placement.loopEnabled && nested.length > 1) {
      losses.push({
        kind: 'unsupported-nested-clip',
        clipName: placement.name ?? defaultName('lossClip'),
        reason: 'loop-with-multiple-events',
      });
    }

    const windowStart = placement.contentWindowStart;
    const windowEnd = windowStart + placement.lengthPpq;
    return nested.flatMap((child): FlattenedClipLeaf[] => {
      if (!clipEnabled(child)) {
        losses.push({
          kind: 'disabled-clip',
          clipName: child.getAttribute('name') || placement.name || defaultName('lossClip'),
        });
        return [];
      }
      const childTime = numberAttr(child, 'time') ?? 0;
      const childLength = Math.max(
        MIN_IMPORTED_LENGTH_PPQ,
        numberAttr(child, 'duration') ?? placement.lengthPpq,
      );
      const visibleStart = Math.max(windowStart, childTime);
      const visibleEnd = Math.min(windowEnd, childTime + childLength);
      if (!(visibleEnd > visibleStart)) return [];
      const childUnit = child.getAttribute('contentTimeUnit')?.trim() || 'beats';
      const childLoop = clipLoopState(child, placement);
      return walk(child, {
        startPpq: placement.startPpq + visibleStart - windowStart,
        lengthPpq: visibleEnd - visibleStart,
        contentWindowStart: (readContentWindow(child).playStart ?? 0) + (visibleStart - childTime),
        contentTimeUnit: childUnit,
        name: child.getAttribute('name') || placement.name,
        ...childLoop,
        fadeElement:
          child.hasAttribute('fadeInTime') || child.hasAttribute('fadeOutTime')
            ? child
            : placement.fadeElement,
      });
    });
  };

  return walk(root, initial);
}

export function readMidiClip(
  clip: Element,
  placement: FlattenedClipPlacement | undefined,
  losses: DawprojectImportLoss[],
): DocumentClip {
  const window = readContentWindow(clip);
  const { loopStart, loopEnd } = window;
  const clipName = placement?.name ?? clip.getAttribute('name') ?? defaultName('midiClip');
  const playStart = alignLoopStart(
    placement?.contentWindowStart ?? window.playStart ?? 0,
    loopStart,
    loopEnd,
    clipName,
    losses,
  );
  const out: DocumentClip = {
    name: clipName,
    startPpq: placement?.startPpq ?? numberAttr(clip, 'time') ?? 0,
    lengthPpq:
      placement?.lengthPpq ??
      Math.max(
        MIN_IMPORTED_LENGTH_PPQ,
        numberAttr(clip, 'duration') ?? DEFAULT_IMPORTED_CLIP_LENGTH_PPQ,
      ),
    sourceOffsetPpq: playStart,
    gain: 1,
    loopEnabled:
      placement?.loopEnabled ?? (loopStart !== null && loopEnd !== null && loopEnd > loopStart),
    loopLengthPpq:
      placement?.loopLengthPpq ??
      (loopStart !== null && loopEnd !== null ? Math.max(0, loopEnd - loopStart) : 0),
    kind: 'midi',
    notes: Array.from(clip.querySelectorAll('Notes > Note')).map((note) => {
      const rel = numberAttr(note, 'rel');
      return {
        pitch: clampInt(numberAttr(note, 'key') ?? 60, 0, 127),
        velocity: normalizedVelocity(numberAttr(note, 'vel')),
        startPpq: Math.max(0, numberAttr(note, 'time') ?? 0),
        durationPpq: Math.max(MIN_IMPORTED_LENGTH_PPQ, numberAttr(note, 'duration') ?? 1),
        channel: clampInt(numberAttr(note, 'channel') ?? 0, 0, 15),
        // Only materialize a release velocity when the note declares one, so an
        // absent 'rel' stays absent instead of defaulting to a fixed value.
        ...(rel !== null ? { offVelocity: clampInt(rel * 127, 1, 127) } : {}),
      };
    }),
  };
  readMidiExpressionPoints(clip, out, losses);
  shiftExpressionLanes(out, playStart);
  return out;
}

interface DawprojectAudioFileRef {
  path: string;
  external: boolean;
}

export function audioFileRef(clip: Element): DawprojectAudioFileRef | null {
  const warps = children(clip, 'Warps')[0];
  const audio = children(clip, 'Audio')[0] ?? children(warps, 'Audio')[0];
  const file = children(audio, 'File')[0];
  if (!file) return null;
  const path = file.getAttribute('path')?.trim();
  const external = boolAttr(file, 'external');
  if (!path) return null;
  if (!external && path.startsWith('/')) return null;
  return { path, external };
}

function reportUnknownTimeUnit(
  clip: Element,
  attribute: Extract<DawprojectImportLoss, { kind: 'unsupported-time-unit' }>['attribute'],
  supported: readonly string[],
  losses: DawprojectImportLoss[],
): string | null {
  const unit = clip.getAttribute(attribute)?.trim() || null;
  if (unit !== null && !supported.includes(unit)) {
    losses.push({
      kind: 'unsupported-time-unit',
      clipName: clip.getAttribute('name') || defaultName('audioClip'),
      attribute,
      unit,
    });
  }
  return unit;
}

function clipContentPpq(
  value: number | null,
  tempoMap: NormalizedTempoMap,
  contentOriginPpq: number,
  contentTimeUnit: string | null,
): number | null {
  if (value === null) return null;
  return contentTimeUnit === 'seconds'
    ? audioContentSecondsToPpq(tempoMap, contentOriginPpq, value)
    : value;
}

function clipFadePpq(
  clip: Element,
  attr: 'fadeInTime' | 'fadeOutTime',
  tempoMap: NormalizedTempoMap,
  startPpq: number,
  lengthPpq: number,
  fadeTimeUnit: string | null,
): number | null {
  const value = numberAttr(clip, attr);
  if (value === null || value <= 0) return null;
  return fadeTimeUnit === 'seconds'
    ? audioFadeSecondsToPpq(
        tempoMap,
        startPpq,
        lengthPpq,
        value,
        attr === 'fadeInTime' ? 'in' : 'out',
      )
    : value;
}

export function readAudioClip(
  clip: Element,
  tempoMap: NormalizedTempoMap,
  mediaAssets: ReadonlyMap<string, string> = new Map(),
  losses: DawprojectImportLoss[] = [],
  placement?: FlattenedClipPlacement,
): DocumentClip {
  const file = audioFileRef(clip);
  const startPpq = placement?.startPpq ?? numberAttr(clip, 'time') ?? 0;
  const lengthPpq =
    placement?.lengthPpq ??
    Math.max(
      MIN_IMPORTED_LENGTH_PPQ,
      numberAttr(clip, 'duration') ?? DEFAULT_IMPORTED_CLIP_LENGTH_PPQ,
    );
  const contentTimeUnit = reportUnknownTimeUnit(
    clip,
    'contentTimeUnit',
    ['beats', 'seconds'],
    losses,
  );
  const window = readContentWindow(clip);
  const playStartValue = placement?.contentWindowStart ?? window.playStart ?? 0;
  const contentOriginPpq =
    contentTimeUnit === 'seconds'
      ? audioContentOriginFromPlayStartSeconds(tempoMap, startPpq, playStartValue)
      : audioContentOriginPpq(startPpq, Math.max(0, playStartValue));
  const playStart = clipContentPpq(playStartValue, tempoMap, contentOriginPpq, contentTimeUnit);
  const loopStart = clipContentPpq(window.loopStart, tempoMap, contentOriginPpq, contentTimeUnit);
  const loopEnd = clipContentPpq(window.loopEnd, tempoMap, contentOriginPpq, contentTimeUnit);
  const fadeElement = placement?.fadeElement ?? clip;
  const fadeTimeUnit = reportUnknownTimeUnit(
    fadeElement,
    'fadeTimeUnit',
    ['beats', 'seconds'],
    losses,
  );
  const fadeInPpq = clipFadePpq(
    fadeElement,
    'fadeInTime',
    tempoMap,
    startPpq,
    lengthPpq,
    fadeTimeUnit,
  );
  const fadeOutPpq = clipFadePpq(
    fadeElement,
    'fadeOutTime',
    tempoMap,
    startPpq,
    lengthPpq,
    fadeTimeUnit,
  );
  const warp = readAudioWarp(clip, placement, playStartValue, lengthPpq, losses);
  const clipName = placement?.name ?? clip.getAttribute('name') ?? defaultName('audioClip');
  return {
    name: clipName,
    startPpq,
    lengthPpq,
    sourceOffsetPpq: Math.max(
      0,
      warp?.sourceOffsetPpq ?? alignLoopStart(playStart ?? 0, loopStart, loopEnd, clipName, losses),
    ),
    gain: 1,
    loopEnabled:
      placement?.loopEnabled ?? (loopStart !== null && loopEnd !== null && loopEnd > loopStart),
    loopLengthPpq:
      placement?.loopLengthPpq ??
      (loopStart !== null && loopEnd !== null ? Math.max(0, loopEnd - loopStart) : 0),
    kind: 'audio',
    notes: [],
    ...(file && mediaAssets.has(file.path)
      ? { assetId: mediaAssets.get(file.path) as string }
      : {}),
    ...(fadeInPpq !== null ? { fadeInPpq } : {}),
    ...(fadeOutPpq !== null ? { fadeOutPpq } : {}),
    ...(warp ? { warp: warp.warp } : {}),
  };
}

function readAudioWarp(
  clip: Element,
  placement: FlattenedClipPlacement | undefined,
  windowStart: number,
  lengthPpq: number,
  losses: DawprojectImportLoss[],
): { sourceOffsetPpq: number; warp: NonNullable<DocumentClip['warp']> } | null {
  const warps = children(clip, 'Warps')[0];
  if (!warps) return null;
  const timeUnit = warps.getAttribute('timeUnit')?.trim() || 'beats';
  const contentTimeUnit = warps.getAttribute('contentTimeUnit')?.trim() || 'seconds';
  const clipName = placement?.name ?? clip.getAttribute('name') ?? defaultName('audioClip');
  if (timeUnit !== 'beats' || contentTimeUnit !== 'seconds') {
    losses.push({
      kind: 'unsupported-warp',
      clipName,
      reason: 'time-units',
      timeUnit,
      contentTimeUnit,
    });
    return null;
  }
  const points = children(warps, 'Warp')
    .map((point) => ({
      time: numberAttr(point, 'time'),
      contentTime: numberAttr(point, 'contentTime'),
    }))
    .filter(
      (point): point is { time: number; contentTime: number } =>
        point.time !== null && point.contentTime !== null,
    )
    .sort((a, b) => a.time - b.time);
  if (points.length < 2) {
    losses.push({ kind: 'unsupported-warp', clipName, reason: 'insufficient-points' });
    return null;
  }
  if (
    points.some(
      (point, index) =>
        index > 0 &&
        (point.time <= points[index - 1].time ||
          point.contentTime <= points[index - 1].contentTime),
    )
  ) {
    losses.push({ kind: 'unsupported-warp', clipName, reason: 'non-monotonic' });
    return null;
  }
  const interpolate = (time: number): number | null => {
    for (let index = 0; index < points.length - 1; index += 1) {
      const left = points[index];
      const right = points[index + 1];
      if (time < left.time || time > right.time) continue;
      const ratio = (time - left.time) / (right.time - left.time);
      return left.contentTime + (right.contentTime - left.contentTime) * ratio;
    }
    return null;
  };
  const windowEnd = windowStart + lengthPpq;
  const sourceStartSeconds = interpolate(windowStart);
  const sourceEndSeconds = interpolate(windowEnd);
  if (
    sourceStartSeconds === null ||
    sourceEndSeconds === null ||
    !(sourceEndSeconds > sourceStartSeconds)
  ) {
    losses.push({ kind: 'unsupported-warp', clipName, reason: 'insufficient-points' });
    return null;
  }
  const sourceBpm = (60 * lengthPpq) / (sourceEndSeconds - sourceStartSeconds);
  const anchors = points
    .filter((point) => point.time > windowStart && point.time < windowEnd)
    .map((point) => ({
      ppq: point.time - windowStart,
      sourceSeconds: point.contentTime - sourceStartSeconds,
    }));
  return {
    sourceOffsetPpq: (sourceStartSeconds * sourceBpm) / 60,
    warp: {
      enabled: true,
      sourceBpm,
      ...(anchors.length > 0 ? { anchors } : {}),
    },
  };
}
