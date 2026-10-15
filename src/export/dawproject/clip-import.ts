import { clampInt } from '@/lib/math';
import type { DocumentClip } from '@/project/serialization';
import type { NormalizedTempoMap } from '@/project/tempo-map';
import {
  audioContentOriginFromPlayStartSeconds,
  audioContentOriginPpq,
  audioContentSecondsToPpq,
  audioFadeSecondsToPpq,
} from './audio-time';
import { DEFAULT_IMPORTED_CLIP_LENGTH_PPQ, MIN_IMPORTED_LENGTH_PPQ } from './format';
import type { DawprojectImportLoss, FlattenedClipLeaf, FlattenedClipPlacement } from './import';
import { readMidiExpressionPoints } from './midi-expression-import';
import { boolAttr, children, numberAttr } from './xml-read';

function normalizedVelocity(value: number | null): number {
  if (value === null) return 96;
  return clampInt(value * 127, 1, 127);
}

function clipLoopState(
  clip: Element,
  inherited?: Pick<FlattenedClipPlacement, 'loopEnabled' | 'loopLengthPpq'>,
): Pick<FlattenedClipPlacement, 'loopEnabled' | 'loopLengthPpq'> {
  const contentTimeUnit = clip.getAttribute('contentTimeUnit')?.trim() || 'beats';
  const loopStart = numberAttr(clip, 'loopStart');
  const loopEnd = numberAttr(clip, 'loopEnd');
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
    losses.push({ kind: 'disabled-clip', clipName: root.getAttribute('name') || 'Clip' });
    return [];
  }
  const rootStart = numberAttr(root, 'time') ?? 0;
  const rootLength = Math.max(
    MIN_IMPORTED_LENGTH_PPQ,
    numberAttr(root, 'duration') ?? DEFAULT_IMPORTED_CLIP_LENGTH_PPQ,
  );
  const rootName = root.getAttribute('name') || 'Audio clip';
  const rootUnit = root.getAttribute('contentTimeUnit')?.trim() || 'beats';
  const rootLoop = clipLoopState(root);
  const initial: FlattenedClipPlacement = {
    startPpq: rootStart,
    lengthPpq: rootLength,
    contentWindowStart: numberAttr(root, 'playStart') ?? 0,
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
        clipName: placement.name,
        reason: 'mixed-time-units',
      });
      return [];
    }
    if (placement.loopEnabled && nested.length > 1) {
      losses.push({
        kind: 'unsupported-nested-clip',
        clipName: placement.name,
        reason: 'loop-with-multiple-events',
      });
    }

    const windowStart = placement.contentWindowStart;
    const windowEnd = windowStart + placement.lengthPpq;
    return nested.flatMap((child): FlattenedClipLeaf[] => {
      if (!clipEnabled(child)) {
        losses.push({
          kind: 'disabled-clip',
          clipName: child.getAttribute('name') || placement.name,
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
        contentWindowStart: (numberAttr(child, 'playStart') ?? 0) + (visibleStart - childTime),
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
  const playStart = placement?.contentWindowStart ?? numberAttr(clip, 'playStart') ?? 0;
  const loopStart = numberAttr(clip, 'loopStart');
  const loopEnd = numberAttr(clip, 'loopEnd');
  const out: DocumentClip = {
    name: placement?.name ?? clip.getAttribute('name') ?? 'MIDI clip',
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
      clipName: clip.getAttribute('name') || 'Audio clip',
      attribute,
      unit,
    });
  }
  return unit;
}

function clipContentPpq(
  clip: Element,
  attr: string,
  tempoMap: NormalizedTempoMap,
  contentOriginPpq: number,
  contentTimeUnit: string | null,
): number | null {
  const value = numberAttr(clip, attr);
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
  const playStartValue = placement?.contentWindowStart ?? numberAttr(clip, 'playStart') ?? 0;
  const contentOriginPpq =
    contentTimeUnit === 'seconds'
      ? audioContentOriginFromPlayStartSeconds(tempoMap, startPpq, playStartValue)
      : audioContentOriginPpq(startPpq, Math.max(0, playStartValue));
  const playStart = clipContentPpq(clip, 'playStart', tempoMap, contentOriginPpq, contentTimeUnit);
  const loopStart = clipContentPpq(clip, 'loopStart', tempoMap, contentOriginPpq, contentTimeUnit);
  const loopEnd = clipContentPpq(clip, 'loopEnd', tempoMap, contentOriginPpq, contentTimeUnit);
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
  const warp = readAudioWarp(clip, placement, lengthPpq, losses);
  return {
    name: placement?.name ?? clip.getAttribute('name') ?? 'Audio clip',
    startPpq,
    lengthPpq,
    sourceOffsetPpq: Math.max(0, warp?.sourceOffsetPpq ?? playStart ?? 0),
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
  lengthPpq: number,
  losses: DawprojectImportLoss[],
): { sourceOffsetPpq: number; warp: NonNullable<DocumentClip['warp']> } | null {
  const warps = children(clip, 'Warps')[0];
  if (!warps) return null;
  const timeUnit = warps.getAttribute('timeUnit')?.trim() || 'beats';
  const contentTimeUnit = warps.getAttribute('contentTimeUnit')?.trim() || 'seconds';
  const clipName = placement?.name ?? clip.getAttribute('name') ?? 'Audio clip';
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
  const windowStart = placement?.contentWindowStart ?? numberAttr(clip, 'playStart') ?? 0;
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
