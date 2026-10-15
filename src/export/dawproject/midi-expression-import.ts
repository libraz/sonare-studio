import { clampInt } from '@/lib/math';
import type { DocumentClip } from '@/project/serialization';
import type { DawprojectImportLoss } from './import';
import { children } from './xml-read';

type MidiExpressionName =
  | 'channelController'
  | 'pitchBend'
  | 'channelPressure'
  | 'polyPressure'
  | 'programChange';

interface MidiExpressionTarget {
  expression: MidiExpressionName;
  channel: number;
  controller?: number;
  key?: number;
}

interface MidiExpressionPoint {
  ppq: number;
  value: number;
  curve?: 'linear';
}

type MidiExpressionTargetAttribute = 'channel' | 'controller' | 'key';

export function midiExpressionLoss(
  clip: Pick<DocumentClip, 'name'>,
  expression: string,
  reason: Extract<DawprojectImportLoss, { kind: 'unsupported-midi-expression' }>['reason'],
  losses: DawprojectImportLoss[],
): void {
  losses.push({ kind: 'unsupported-midi-expression', clipName: clip.name, expression, reason });
}

function readMidiTargetInteger(
  target: Element,
  attribute: MidiExpressionTargetAttribute,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; reason: 'missing' | 'invalid' } {
  const raw = target.getAttribute(attribute)?.trim();
  if (!raw) return { ok: false, reason: 'missing' };
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? { ok: true, value }
    : { ok: false, reason: 'invalid' };
}

function midiTargetAttributeLossReason(
  attribute: MidiExpressionTargetAttribute,
  reason: 'missing' | 'invalid',
): Extract<DawprojectImportLoss, { kind: 'unsupported-midi-expression' }>['reason'] {
  return `${reason}-${attribute}` as Extract<
    DawprojectImportLoss,
    { kind: 'unsupported-midi-expression' }
  >['reason'];
}

function readOfficialMidiExpressionTarget(target: Element):
  | { ok: true; target: MidiExpressionTarget }
  | {
      ok: false;
      reason: Extract<DawprojectImportLoss, { kind: 'unsupported-midi-expression' }>['reason'];
    } {
  const expression = target.getAttribute('expression')?.trim() ?? '';
  if (
    expression !== 'channelController' &&
    expression !== 'pitchBend' &&
    expression !== 'channelPressure' &&
    expression !== 'polyPressure' &&
    expression !== 'programChange'
  ) {
    return { ok: false, reason: 'unknown-expression' };
  }
  const channel = readMidiTargetInteger(target, 'channel', 0, 15);
  if (!channel.ok) {
    return { ok: false, reason: midiTargetAttributeLossReason('channel', channel.reason) };
  }
  if (expression === 'channelController') {
    const controller = readMidiTargetInteger(target, 'controller', 0, 127);
    if (!controller.ok) {
      return {
        ok: false,
        reason: midiTargetAttributeLossReason('controller', controller.reason),
      };
    }
    return {
      ok: true,
      target: { expression, channel: channel.value, controller: controller.value },
    };
  }
  if (expression === 'polyPressure') {
    const key = readMidiTargetInteger(target, 'key', 0, 127);
    if (!key.ok) {
      return { ok: false, reason: midiTargetAttributeLossReason('key', key.reason) };
    }
    return { ok: true, target: { expression, channel: channel.value, key: key.value } };
  }
  return { ok: true, target: { expression, channel: channel.value } };
}

function readLegacyMidiExpressionTarget(parameter: string):
  | { ok: true; target: MidiExpressionTarget }
  | {
      ok: false;
      reason: Extract<DawprojectImportLoss, { kind: 'unsupported-midi-expression' }>['reason'];
    }
  | null {
  const parts = parameter.split('.');
  if (parts[0] !== 'midi') return null;
  const readIndex = (raw: string | undefined, min: number, max: number): number | null => {
    if (raw === undefined || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : null;
  };
  const channel = readIndex(parts[2], 0, 15);
  if (parts[1] === 'cc' && parts.length === 4) {
    const controller = readIndex(parts[3], 0, 127);
    return channel === null || controller === null
      ? { ok: false, reason: 'malformed-point' }
      : { ok: true, target: { expression: 'channelController', channel, controller } };
  }
  if (parts[1] === 'pitchBend' && parts.length === 3) {
    return channel === null
      ? { ok: false, reason: 'malformed-point' }
      : { ok: true, target: { expression: 'pitchBend', channel } };
  }
  if (parts[1] === 'program' && parts.length === 3) {
    return channel === null
      ? { ok: false, reason: 'malformed-point' }
      : { ok: true, target: { expression: 'programChange', channel } };
  }
  if (parts[1] === 'channelPressure' && parts.length === 3) {
    return channel === null
      ? { ok: false, reason: 'malformed-point' }
      : { ok: true, target: { expression: 'channelPressure', channel } };
  }
  if (parts[1] === 'polyPressure' && parts.length === 4) {
    const key = readIndex(parts[3], 0, 127);
    return channel === null || key === null
      ? { ok: false, reason: 'malformed-point' }
      : { ok: true, target: { expression: 'polyPressure', channel, key } };
  }
  return { ok: false, reason: 'unknown-expression' };
}

function readMidiExpressionPointsElement(
  points: Element,
  pointName: 'RealPoint' | 'IntegerPoint',
  normalizedMaximum: number | null,
): MidiExpressionPoint[] | null {
  const unit = points.getAttribute('unit')?.trim() ?? '';
  if (pointName === 'RealPoint' && unit !== '' && unit !== 'linear' && unit !== 'normalized') {
    return null;
  }
  const normalized = unit === 'normalized';
  const pointElements = children(points).filter((point) => point.tagName !== 'Target');
  if (pointElements.length === 0 || pointElements.some((point) => point.tagName !== pointName)) {
    return null;
  }
  const parsed: MidiExpressionPoint[] = [];
  for (const point of pointElements) {
    const rawTime = point.getAttribute('time')?.trim();
    const rawValue = point.getAttribute('value')?.trim();
    if (!rawTime || !rawValue) return null;
    const ppq = Number(rawTime);
    const value = Number(rawValue);
    if (!Number.isFinite(ppq) || !Number.isFinite(value)) return null;
    if (pointName === 'IntegerPoint' && !Number.isInteger(value)) return null;
    const interpolation = point.getAttribute('interpolation')?.trim();
    if (pointName === 'RealPoint' && interpolation !== undefined && interpolation !== '') {
      if (interpolation !== 'hold' && interpolation !== 'linear') return null;
    }
    parsed.push({
      ppq,
      value: normalized && normalizedMaximum !== null ? value * normalizedMaximum : value,
      ...(interpolation === 'linear' ? { curve: 'linear' } : {}),
    });
  }
  return parsed;
}

export function readMidiExpressionPoints(
  clipElement: Element,
  clip: DocumentClip,
  losses: DawprojectImportLoss[],
): void {
  const ccLanes: NonNullable<DocumentClip['ccLanes']> = [];
  const pitchBendLanes: NonNullable<DocumentClip['pitchBendLanes']> = [];
  const programChangeLanes: NonNullable<DocumentClip['programChangeLanes']> = [];
  const channelPressureLanes: NonNullable<DocumentClip['channelPressureLanes']> = [];
  const polyPressureLanes: NonNullable<DocumentClip['polyPressureLanes']> = [];
  // A DAWproject Clip owns a <Points> child, while timeline-level expression
  // is itself a <Points> timeline. Supporting both here avoids making the
  // official track-targeted form a special, silently dropped parser path.
  const pointTimelines =
    clipElement.tagName === 'Points' ? [clipElement] : children(clipElement, 'Points');
  for (const points of pointTimelines) {
    const targets = children(points, 'Target');
    const pointElements = children(points).filter((point) => point.tagName !== 'Target');
    if (pointElements.length === 0) continue;
    const targetElement = targets[0];
    const parameter = targetElement?.getAttribute('parameter')?.trim() ?? '';
    const expression = targetElement?.getAttribute('expression')?.trim() ?? parameter;
    if (targets.length !== 1 || !targetElement) {
      midiExpressionLoss(clip, expression, 'missing-target', losses);
      continue;
    }

    let parsedTarget:
      | { ok: true; target: MidiExpressionTarget }
      | {
          ok: false;
          reason: Extract<DawprojectImportLoss, { kind: 'unsupported-midi-expression' }>['reason'];
        }
      | null;
    if (targetElement.hasAttribute('expression')) {
      parsedTarget = readOfficialMidiExpressionTarget(targetElement);
    } else {
      parsedTarget = readLegacyMidiExpressionTarget(parameter);
      if (parsedTarget === null) {
        midiExpressionLoss(clip, parameter, 'unknown-expression', losses);
        continue;
      }
    }
    if (!parsedTarget.ok) {
      midiExpressionLoss(clip, expression, parsedTarget.reason, losses);
      continue;
    }
    const target = parsedTarget.target;
    const isLegacy = !targetElement.hasAttribute('expression');
    const pointName =
      target.expression === 'programChange' && !isLegacy ? 'IntegerPoint' : 'RealPoint';
    const normalizedMaximum =
      target.expression === 'channelController' ||
      target.expression === 'channelPressure' ||
      target.expression === 'polyPressure'
        ? 127
        : target.expression === 'pitchBend'
          ? 16383
          : null;
    const parsedPoints = readMidiExpressionPointsElement(
      points,
      pointName,
      isLegacy ? null : normalizedMaximum,
    );
    if (parsedPoints === null) {
      midiExpressionLoss(clip, expression, 'unsupported-point-type', losses);
      continue;
    }
    if (target.expression === 'channelController') {
      ccLanes.push({
        channel: target.channel,
        controller: target.controller as number,
        points: parsedPoints.map((point) => ({
          ppq: point.ppq,
          value: clampInt(point.value, 0, 127),
          ...(point.curve !== undefined ? { curve: point.curve } : {}),
        })),
      });
    } else if (target.expression === 'pitchBend') {
      pitchBendLanes.push({
        channel: target.channel,
        points: parsedPoints.map((point) => ({
          ppq: point.ppq,
          value: clampInt(point.value, 0, 16383),
          ...(point.curve !== undefined ? { curve: point.curve } : {}),
        })),
      });
    } else if (target.expression === 'programChange') {
      programChangeLanes.push({
        channel: target.channel,
        points: parsedPoints.map((point) => ({
          ppq: point.ppq,
          program: clampInt(point.value, 0, 127),
        })),
      });
    } else if (target.expression === 'channelPressure') {
      channelPressureLanes.push({
        channel: target.channel,
        points: parsedPoints.map((point) => ({
          ppq: point.ppq,
          value: clampInt(point.value, 0, 127),
          ...(point.curve !== undefined ? { curve: point.curve } : {}),
        })),
      });
    } else {
      polyPressureLanes.push({
        channel: target.channel,
        pitch: target.key as number,
        points: parsedPoints.map((point) => ({
          ppq: point.ppq,
          value: clampInt(point.value, 0, 127),
          ...(point.curve !== undefined ? { curve: point.curve } : {}),
        })),
      });
    }
  }
  if (ccLanes.length > 0) clip.ccLanes = ccLanes;
  if (pitchBendLanes.length > 0) clip.pitchBendLanes = pitchBendLanes;
  if (programChangeLanes.length > 0) clip.programChangeLanes = programChangeLanes;
  if (channelPressureLanes.length > 0) clip.channelPressureLanes = channelPressureLanes;
  if (polyPressureLanes.length > 0) clip.polyPressureLanes = polyPressureLanes;
}

export function isPotentialMidiExpressionPoints(points: Element): boolean {
  const target = children(points, 'Target')[0];
  if (!target) return true;
  if (target.hasAttribute('expression')) return true;
  return target.getAttribute('parameter')?.trim().startsWith('midi.') === true;
}

export function midiExpressionName(points: Element): string {
  const target = children(points, 'Target')[0];
  return (
    target?.getAttribute('expression')?.trim() ?? target?.getAttribute('parameter')?.trim() ?? ''
  );
}

export function hasMidiExpressionLanes(clip: DocumentClip): boolean {
  return (
    (clip.ccLanes?.length ?? 0) > 0 ||
    (clip.pitchBendLanes?.length ?? 0) > 0 ||
    (clip.programChangeLanes?.length ?? 0) > 0 ||
    (clip.channelPressureLanes?.length ?? 0) > 0 ||
    (clip.polyPressureLanes?.length ?? 0) > 0
  );
}
