/** Reads the DAWproject Arrangement: clip lanes, timeline MIDI expression, parameter automation and markers. */

import {
  type AutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import { defaultName } from '@/project/default-names';
import { isAutomatableSynthParam } from '@/project/instrument';
import type {
  DocumentAutomationLane,
  DocumentClip,
  ProjectDocument,
} from '@/project/serialization';
import type { NormalizedTempoMap } from '@/project/tempo-map';
import { DawprojectImportError } from './archive-import';
import { flattenClipLeaves, readAudioClip, readMidiClip } from './clip-import';
import { MIN_IMPORTED_LENGTH_PPQ, SONARE_AUTOMATION_PARAMETER_PREFIX } from './format';
import type { DawprojectImportLoss } from './import-loss';
import {
  hasMidiExpressionLanes,
  isPotentialMidiExpressionPoints,
  midiExpressionLoss,
  midiExpressionName,
  readMidiExpressionPoints,
} from './midi-expression-import';
import type { AutomationParameterRef, ImportedMaster, ImportedTrack } from './structure-import';
import { children, numberAttr } from './xml-read';

/**
 * Sonare's arrangement positions are PPQ. A seconds-based arrangement needs
 * a full tempo-map conversion (including ramps), so accepting it as PPQ would
 * silently move clips and automation. Reject it before any media is ingested.
 */
export function assertBeatBasedArrangement(project: Document): void {
  const timedElements = project.querySelectorAll(
    'Arrangement[timeUnit], Arrangement Lanes[timeUnit], Arrangement > TempoAutomation[timeUnit], Arrangement > TimeSignatureAutomation[timeUnit], Arrangement > Markers[timeUnit]',
  );
  for (const element of timedElements) {
    const timeUnit = element.getAttribute('timeUnit')?.trim() || 'beats';
    if (timeUnit === 'beats') continue;
    throw new DawprojectImportError(
      `Unsupported DAWproject arrangement timeUnit "${timeUnit}" on ${element.tagName}; import refused to preserve timing`,
    );
  }
}

/** The element's own non-beat `timeUnit`, or null when it is beat-based. */
function nonBeatTimeUnit(element: Element | undefined): string | null {
  const unit = element?.getAttribute('timeUnit')?.trim();
  return unit && unit !== 'beats' ? unit : null;
}

/**
 * Reifies a DAWproject timeline-level MIDI expression as one CC-only clip.
 * Its Points times are arrangement-relative, so the carrier starts at zero
 * and retains those times as its source-relative expression positions.
 */
function readArrangementMidiExpressionClip(
  points: Element,
  track: ImportedTrack,
  losses: DawprojectImportLoss[],
): DocumentClip | null {
  let lengthPpq = MIN_IMPORTED_LENGTH_PPQ;
  for (const point of children(points)) {
    if (point.tagName === 'Target') continue;
    const time = numberAttr(point, 'time');
    if (time !== null && time >= 0) lengthPpq = Math.max(lengthPpq, time);
  }
  const clip: DocumentClip = {
    name: defaultName('midiExpression', { name: track.name }),
    startPpq: 0,
    lengthPpq,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    kind: 'midi',
    notes: [],
  };
  readMidiExpressionPoints(points, clip, losses);
  return hasMidiExpressionLanes(clip) ? clip : null;
}

export function attachArrangementClips(
  project: Document,
  tracks: ImportedTrack[],
  tempoMap: NormalizedTempoMap,
  mediaAssets: ReadonlyMap<string, string>,
  losses: DawprojectImportLoss[],
): void {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  for (const lane of children(arrangementLanes, 'Lanes')) {
    const trackId = lane.getAttribute('track') ?? '';
    const track = byId.get(trackId);
    const clipsTimeline = children(lane, 'Clips')[0];
    const clips = children(clipsTimeline, 'Clip');
    if (!track) {
      if (clips.length > 0)
        losses.push({ kind: 'orphan-lane', track: trackId || defaultName('lossLanes') });
      continue;
    }
    const clipsUnit = nonBeatTimeUnit(clipsTimeline);
    if (clipsUnit !== null && clips.length > 0) {
      losses.push({
        kind: 'unsupported-time-unit',
        clipName: track.name,
        attribute: 'timeUnit',
        unit: clipsUnit,
      });
      continue;
    }
    for (const clip of clips) {
      for (const leaf of flattenClipLeaves(clip, losses)) {
        const points = children(leaf.element, 'Points');
        const hasMidiContent =
          children(leaf.element, 'Notes').length > 0 ||
          (points.length > 0 && track.kind === 'midi');
        const contentUnit =
          leaf.placement.contentTimeUnit !== 'beats' ? leaf.placement.contentTimeUnit : null;
        const timelineUnit = [...children(leaf.element, 'Notes'), ...points]
          .map(nonBeatTimeUnit)
          .find((unit) => unit !== null);
        if (hasMidiContent && (contentUnit !== null || timelineUnit !== undefined)) {
          // MIDI note and expression times are read as beats; any other unit
          // would land them at the wrong position.
          losses.push({
            kind: 'unsupported-time-unit',
            clipName: leaf.placement.name ?? defaultName('lossClip'),
            attribute: contentUnit !== null ? 'contentTimeUnit' : 'timeUnit',
            unit: contentUnit ?? timelineUnit ?? '',
          });
        } else if (hasMidiContent) {
          // The official schema makes Clip content a choice: an expression
          // clip contains Points *instead of* Notes. A notes-only predicate
          // therefore misclassified valid MIDI expression clips as audio.
          track.clips.push(readMidiClip(leaf.element, leaf.placement, losses));
        } else if (points.some(isPotentialMidiExpressionPoints)) {
          // A MIDI expression on a non-MIDI track has no faithful Sonare
          // destination. Report it rather than manufacture an audio clip or
          // silently discard its non-empty timeline.
          const clipName = leaf.placement.name ?? defaultName('lossClip');
          for (const entry of points.filter(isPotentialMidiExpressionPoints)) {
            midiExpressionLoss(
              { name: clipName },
              midiExpressionName(entry),
              'non-midi-track',
              losses,
            );
          }
        } else {
          track.clips.push(
            readAudioClip(leaf.element, tempoMap, mediaAssets, losses, leaf.placement),
          );
        }
      }
    }
  }
}

/**
 * Imports official arrangement-level MIDI expression (`<Points track="…">`).
 * Sonare stores expression on clips, so a zero-origin CC-only carrier keeps
 * the point positions and makes the expression audible without inventing
 * notes. Malformed or unaddressable non-empty timelines become explicit loss
 * entries instead of disappearing during the automation pass.
 */
export function attachArrangementMidiExpressions(
  project: Document,
  tracks: ImportedTrack[],
  losses: DawprojectImportLoss[],
): void {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  if (!arrangementLanes) return;
  for (const points of Array.from(arrangementLanes.querySelectorAll('Points'))) {
    if (points.closest('Clip') || !isPotentialMidiExpressionPoints(points)) continue;
    const pointElements = children(points).filter((point) => point.tagName !== 'Target');
    if (pointElements.length === 0) continue;
    const trackId =
      points.getAttribute('track')?.trim() ||
      points.parentElement?.getAttribute('track')?.trim() ||
      '';
    const track = byId.get(trackId);
    const name = midiExpressionName(points);
    const unit = nonBeatTimeUnit(points);
    if (unit !== null) {
      losses.push({
        kind: 'unsupported-time-unit',
        clipName: track?.name ?? name,
        attribute: 'timeUnit',
        unit,
      });
      continue;
    }
    if (!track) {
      midiExpressionLoss(
        { name: defaultName('lossMidiExpression') },
        name,
        'missing-track',
        losses,
      );
      continue;
    }
    if (track.kind !== 'midi') {
      midiExpressionLoss({ name: track.name }, name, 'non-midi-track', losses);
      continue;
    }
    const clip = readArrangementMidiExpressionClip(points, track, losses);
    if (clip) track.clips.push(clip);
  }
}

function readAutomationLane(
  points: Element,
  refs: ReadonlyMap<string, AutomationParameterRef>,
): DocumentAutomationLane | null {
  const parameter = points.querySelector('Target')?.getAttribute('parameter')?.trim();
  if (!parameter) return null;
  const ref = refs.get(parameter) ?? sonareAutomationParameterRef(parameter);
  if (!ref) return null;
  const automationPoints: DocumentAutomationLane['points'] = [];
  for (const point of children(points, 'RealPoint')) {
    const ppq = numberAttr(point, 'time');
    const value = numberAttr(point, 'value');
    if (ppq === null || value === null) continue;
    automationPoints.push({
      ppq,
      value: ref.fromDawValue(value),
      ...(point.getAttribute('interpolation') === 'hold'
        ? { curve: 'hold' as const }
        : { curve: 'linear' as const }),
    });
  }
  return automationPoints.length > 0
    ? { param: ref.param, points: automationPoints, enabled: true }
    : null;
}

/** Restores vendor-scoped instrument/mastering automation emitted by sonare. */
function sonareAutomationParameterRef(parameter: string): AutomationParameterRef | undefined {
  if (!parameter.startsWith(SONARE_AUTOMATION_PARAMETER_PREFIX)) return undefined;
  let param: string;
  try {
    param = decodeURIComponent(parameter.slice(SONARE_AUTOMATION_PARAMETER_PREFIX.length));
  } catch {
    return undefined;
  }
  const instrumentRef = parseInstrumentAutomationParam(param);
  if (instrumentRef !== undefined) {
    if (!isAutomatableSynthParam(instrumentRef.paramName)) return undefined;
  } else if (parseMasteringAutomationParam(param) === undefined) {
    return undefined;
  }
  return { param: param as AutomationParam, fromDawValue: (value) => value };
}

export function attachArrangementAutomation(
  project: Document,
  tracks: ImportedTrack[],
  mixer: ProjectDocument['mixer'] | undefined,
  master: ImportedMaster,
  losses: DawprojectImportLoss[],
): DocumentAutomationLane[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const masterAutomation: DocumentAutomationLane[] = [];
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  // DAWproject permits Points directly under the arrangement Lanes timeline;
  // DAWs emit that form for track-targeted MIDI expression. Parameter
  // automation uses the same placement, so handle both the root and ordinary
  // per-track lane containers here.
  for (const lane of [arrangementLanes, ...children(arrangementLanes, 'Lanes')]) {
    const points = children(lane, 'Points');
    for (const entry of points) {
      const laneTrackId = entry.getAttribute('track') ?? lane?.getAttribute('track') ?? '';
      if (!laneTrackId || isPotentialMidiExpressionPoints(entry)) continue;
      const parameter = entry.querySelector('Target')?.getAttribute('parameter')?.trim() ?? '';
      const hasPoints = children(entry, 'RealPoint').length > 0;
      const track = byId.get(laneTrackId);
      const unit = nonBeatTimeUnit(entry);
      if (unit !== null) {
        if (hasPoints) {
          losses.push({
            kind: 'unsupported-time-unit',
            clipName: track?.name ?? laneTrackId,
            attribute: 'timeUnit',
            unit,
          });
        }
        continue;
      }
      if (track) {
        const automation = readAutomationLane(entry, track.automationRefs);
        if (automation === null || (track.kind === 'group' && automation.param === 'pan')) {
          if (hasPoints) {
            losses.push({ kind: 'unmapped-automation', trackName: track.name, parameter });
          }
          continue;
        }
        if (track.mixerBusId) {
          const bus = mixer?.buses.find((entry) => entry.id === track.mixerBusId);
          if (bus) bus.automation = [...(bus.automation ?? []), automation];
        } else {
          track.automation.push(automation);
        }
        continue;
      }
      if (laneTrackId === master.trackId) {
        const automation = readAutomationLane(entry, master.automationRefs);
        if (automation) masterAutomation.push(automation);
        else if (hasPoints) {
          losses.push({ kind: 'unmapped-automation', trackName: defaultName('master'), parameter });
        }
      } else if (hasPoints) {
        losses.push({ kind: 'orphan-lane', track: laneTrackId });
      }
    }
  }
  return masterAutomation;
}

export function readMarkers(project: Document): ProjectDocument['markers'] {
  return Array.from(project.querySelectorAll('Arrangement > Markers > Marker'))
    .map((marker) => ({
      ppq: numberAttr(marker, 'time') ?? 0,
      name: marker.getAttribute('name') || defaultName('marker'),
    }))
    .sort((a, b) => a.ppq - b.ppq);
}
