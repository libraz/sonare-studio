/** Builds the project.xml element tree: Structure channels with their sends and inserts, and the Arrangement lanes that automate them. */

import { SECTION_MARKER_PREFIX } from '@/export/constants';
import { isFiniteNumber } from '@/lib/math';
import {
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import { insertIndexForAutomationRef } from '@/project/automation-insert';
import {
  clampPan,
  dbToLinear,
  type InsertSlot,
  type MixerStrip,
  type StripSend,
} from '@/project/mixer';
import { catalogParamInfo } from '@/project/processor-controls';
import type { DocumentAutomationLane, ProjectDocument } from '@/project/serialization';
import type { NormalizedTempoMap } from '@/project/tempo-map';
import { translateTempoMapForExport } from '@/project/tempo-map-export';
import { isAudioClip } from '@/project/types';
import { type AudioAssetEntry, audioClipElement, midiClipElement } from './clip-export';
import { hexColor, isGroupPanAutomation, vcaGainDbByGroupId } from './export-rules';
import { busChannelId, MASTER_CHANNEL_ID, SONARE_AUTOMATION_PARAMETER_PREFIX } from './format';
import { SONARE_DEVICE_VENDOR } from './sonare-metadata';
import {
  tempoAutomationElement,
  timeSignatureAutomationElement,
  transportElement,
} from './transport-export';
import type { XmlElement } from './xml';

/** DAWproject format version written to the root element. */
const DAWPROJECT_FORMAT_VERSION = '1.0';

/** Application identity written to the <Application> element. */
const APPLICATION_NAME = 'sonare-studio';

/** Neutral strip values used when a track carries no mixer strip. */
const NEUTRAL_STRIP: MixerStrip = { gainDb: 0, pan: 0, inserts: [], sends: [] };

/** Conventional upper bound of a DAWproject linear Volume parameter (+6 dB). */
const DEFAULT_VOLUME_MAX = 2;

/** Maps a [-1, 1] balance pan to the DAWproject normalized [0, 1] range. */
function panToNormalized(pan: number): number {
  return (clampPan(pan) + 1) / 2;
}

/** Sanitizes a dynamic segment used inside DAWproject XML ids. */
function xmlIdSegment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return clean.length > 0 ? clean : 'param';
}

/** Builds a RealParameter element (Volume/Pan style). */
function realParameter(
  name: string,
  id: string,
  unit: string,
  value: number,
  min: number,
  max: number,
): XmlElement {
  return { name, attributes: { id, unit, min, max, value } };
}

/** Builds one generic DAWproject device for a sonare insert slot. */
function insertDeviceElement(slot: InsertSlot, id: string): XmlElement {
  const parameters = Object.entries(slot.params).flatMap(([name, value]): XmlElement[] => {
    if (isFiniteNumber(value)) {
      return [
        {
          name: 'RealParameter',
          attributes: { id: `${id}-param-${xmlIdSegment(name)}`, name, unit: 'normalized', value },
        },
      ];
    }
    if (typeof value === 'boolean') {
      return [
        {
          name: 'BoolParameter',
          attributes: { id: `${id}-param-${xmlIdSegment(name)}`, name, value },
        },
      ];
    }
    const choices =
      catalogParamInfo(slot.processor).find((info) => info.name === name)?.choices ?? [];
    const index = choices.findIndex((choice) => choice.name === value);
    if (index < 0) return [];
    return [
      {
        name: 'EnumParameter',
        attributes: {
          id: `${id}-param-${xmlIdSegment(name)}`,
          name,
          count: choices.length,
          labels: choices.map((choice) => choice.name).join(' '),
          value: index,
        },
      },
    ];
  });
  return {
    name: 'BuiltinDevice',
    attributes: {
      id,
      deviceName: slot.processor,
      deviceRole: 'audioFX',
      deviceVendor: SONARE_DEVICE_VENDOR,
      loaded: true,
    },
    children: [
      ...(parameters.length > 0 ? [{ name: 'Parameters', children: parameters }] : []),
      { name: 'Enabled', attributes: { id: `${id}-enabled`, value: slot.enabled } },
    ],
  };
}

/** Builds the Channel/Devices element for one sonare insert chain. */
function devicesElement(inserts: ReadonlyArray<InsertSlot>, idPrefix: string): XmlElement | null {
  if (inserts.length === 0) return null;
  return {
    name: 'Devices',
    children: inserts.map((slot, index) =>
      insertDeviceElement(slot, `${idPrefix}-insert-${index}`),
    ),
  };
}

/** Builds DAWproject Send elements for a track strip. */
function sendsElement(
  sends: ReadonlyArray<StripSend>,
  busChannelIdByBusId: ReadonlyMap<string, string>,
  channelId: string,
): XmlElement | null {
  const children = sends.flatMap((send, index): XmlElement[] => {
    const destination = busChannelIdByBusId.get(send.busId);
    if (!destination) return [];
    const sendId = `${channelId}-send-${index}`;
    return [
      {
        name: 'Send',
        attributes: {
          id: sendId,
          destination,
          type: send.timing === 'preFader' ? 'pre' : 'post',
        },
        children: [
          { name: 'Mute', attributes: { id: `${sendId}-mute`, value: !send.enabled } },
          realParameter(
            'Volume',
            `${sendId}-volume`,
            'linear',
            Math.max(0, dbToLinear(send.levelDb)),
            0,
            DEFAULT_VOLUME_MAX,
          ),
        ],
      },
    ];
  });
  return children.length > 0 ? { name: 'Sends', children } : null;
}

/** Builds one Channel element from track-level and strip-level state. */
function channelElement(
  id: string,
  role: 'regular' | 'master' | 'effect',
  volume: number,
  pan: number,
  mute: boolean,
  solo: boolean,
  destination?: string,
  sends?: XmlElement | null,
  devices?: XmlElement | null,
): XmlElement {
  // Preserve loud gains instead of clamping at +6 dB: widen the parameter's
  // max to fit any value above the conventional bound (a member track folding
  // in a VCA offset can legitimately exceed it) so nothing is silently lost.
  const value = Math.max(0, volume);
  return {
    name: 'Channel',
    attributes: { id, role, audioChannels: 2, solo, destination },
    children: [
      ...(devices ? [devices] : []),
      { name: 'Mute', attributes: { id: `${id}-mute`, value: mute } },
      realParameter('Pan', `${id}-pan`, 'normalized', panToNormalized(pan), 0, 1),
      ...(sends ? [sends] : []),
      realParameter(
        'Volume',
        `${id}-volume`,
        'linear',
        value,
        0,
        Math.max(DEFAULT_VOLUME_MAX, value),
      ),
    ],
  };
}

/** Builds the Structure track list (regular tracks plus the master track). */
function structureElement(doc: ProjectDocument): XmlElement {
  // A VCA carries no audio of its own; DAWproject has no VCA concept, so its
  // per-member dB offset is folded into each assigned track's channel volume
  // (matching the realtime mixer's per-member gain delta).
  const vcaGainDbById = vcaGainDbByGroupId(doc);
  const busChannelIdByBusId = new Map(
    (doc.mixer?.buses ?? []).map((bus, index) => [bus.id, busChannelId(index)]),
  );
  const trackElements: XmlElement[] = doc.tracks.map((track, index): XmlElement => {
    const strip = track.mixer ?? NEUTRAL_STRIP;
    const audiblePan = track.mixer?.pan ?? track.pan;
    const vcaOffsetDb = track.vcaId !== undefined ? (vcaGainDbById.get(track.vcaId) ?? 0) : 0;
    const channelId = `channel-${index}`;
    // DAWproject nesting alone does not route audio in every host. Mirror the
    // engine's priority: a valid group owns its member output, ahead of any
    // explicit return-bus route, so the group's fader and inserts stay audible.
    const group = track.groupIndex !== undefined ? doc.tracks[track.groupIndex] : undefined;
    const destination =
      group?.kind === 'group'
        ? `channel-${track.groupIndex}`
        : strip.outputBusId !== undefined
          ? (busChannelIdByBusId.get(strip.outputBusId) ?? MASTER_CHANNEL_ID)
          : MASTER_CHANNEL_ID;
    return {
      name: 'Track',
      attributes: {
        id: `track-${index}`,
        contentType: track.kind === 'group' ? 'tracks' : track.kind === 'midi' ? 'notes' : 'audio',
        loaded: true,
        name: track.name,
        color: hexColor(track.color),
      },
      children: [
        channelElement(
          channelId,
          track.kind === 'aux' ? 'effect' : 'regular',
          track.volume * dbToLinear(strip.gainDb) * dbToLinear(vcaOffsetDb),
          audiblePan,
          track.mute,
          track.solo,
          destination,
          sendsElement(strip.sends ?? [], busChannelIdByBusId, channelId),
          devicesElement(strip.inserts, channelId),
        ),
      ],
    };
  });
  const topLevelTracks: XmlElement[] = [];
  trackElements.forEach((trackElement, index) => {
    const groupIndex = doc.tracks[index].groupIndex;
    const parent =
      groupIndex !== undefined && doc.tracks[groupIndex]?.kind === 'group'
        ? trackElements[groupIndex]
        : undefined;
    if (parent && parent !== trackElement) {
      parent.children = [...(parent.children ?? []), trackElement];
    } else {
      topLevelTracks.push(trackElement);
    }
  });
  const busTracks = (doc.mixer?.buses ?? []).map((bus, index): XmlElement => {
    const strip = bus.strip ?? NEUTRAL_STRIP;
    const channelId = busChannelIdByBusId.get(bus.id) ?? busChannelId(index);
    return {
      name: 'Track',
      attributes: {
        id: `bus-track-${index}`,
        contentType: 'audio',
        loaded: true,
        name: bus.name,
      },
      children: [
        channelElement(
          channelId,
          'effect',
          dbToLinear(bus.gainDb),
          strip.pan,
          false,
          false,
          MASTER_CHANNEL_ID,
          null,
          devicesElement(strip.inserts, channelId),
        ),
      ],
    };
  });
  const master = doc.mixer?.master ?? NEUTRAL_STRIP;
  return {
    name: 'Structure',
    children: [
      ...topLevelTracks,
      ...busTracks,
      {
        name: 'Track',
        attributes: { id: 'master-track', contentType: 'tracks', loaded: true, name: 'Master' },
        children: [
          channelElement(
            MASTER_CHANNEL_ID,
            'master',
            dbToLinear(master.gainDb),
            master.pan,
            false,
            false,
            undefined,
            null,
            devicesElement(master.inserts, MASTER_CHANNEL_ID),
          ),
        ],
      },
    ],
  };
}

function automationInterpolation(curve: DocumentAutomationLane['points'][number]['curve']): string {
  return curve === 'hold' ? 'hold' : 'linear';
}

function channelAutomationPointsElement(
  lane: DocumentAutomationLane,
  idPrefix: string,
  channelId: string,
  strip: MixerStrip | undefined,
  faderOffsetDb = 0,
): XmlElement | null {
  if (!lane.enabled || lane.points.length === 0) return null;
  let parameter: string;
  let unit: string;
  let pointValue: (value: number) => number;
  if (lane.param === 'faderDb') {
    parameter = `${channelId}-volume`;
    unit = 'linear';
    pointValue = (value) => dbToLinear(value + faderOffsetDb);
  } else if (lane.param === 'pan') {
    parameter = `${channelId}-pan`;
    unit = 'normalized';
    pointValue = panToNormalized;
  } else {
    const insertRef = parseInsertAutomationParam(lane.param);
    if (insertRef) {
      const insertIndex = strip ? insertIndexForAutomationRef(strip.inserts, insertRef) : undefined;
      const slot = insertIndex === undefined ? undefined : strip?.inserts[insertIndex];
      const param = slot?.params[insertRef.paramName];
      if (typeof param !== 'number' && typeof param !== 'boolean') return null;
      parameter = `${channelId}-insert-${insertIndex}-param-${xmlIdSegment(insertRef.paramName)}`;
      unit = typeof param === 'boolean' ? 'bool' : 'normalized';
      pointValue =
        typeof param === 'boolean' ? (value) => (value >= 0.5 ? 1 : 0) : (value) => value;
    } else if (
      parseInstrumentAutomationParam(lane.param) !== undefined ||
      parseMasteringAutomationParam(lane.param) !== undefined
    ) {
      // DAWproject has no portable parameter identity for sonare synth patches
      // or mastering processors. Keep their exact token in a vendor Target so
      // sonare can round-trip it; other hosts may safely ignore this lane.
      parameter = `${SONARE_AUTOMATION_PARAMETER_PREFIX}${encodeURIComponent(lane.param)}`;
      unit = 'normalized';
      pointValue = (value) => value;
    } else {
      return null;
    }
  }
  return {
    name: 'Points',
    attributes: {
      id: `automation-${idPrefix}-${xmlIdSegment(lane.param)}`,
      unit,
    },
    children: [
      { name: 'Target', attributes: { parameter } },
      ...lane.points.map(
        (point): XmlElement => ({
          name: 'RealPoint',
          attributes: {
            time: point.ppq,
            value: pointValue(point.value),
            interpolation: automationInterpolation(point.curve),
          },
        }),
      ),
    ],
  };
}

/**
 * Builds the cue marker list: document markers plus one marker per section
 * start (sections have no DAWproject element), ordered by time.
 */
function markersElement(doc: ProjectDocument): XmlElement | null {
  const markers = [
    ...doc.markers.map((marker) => ({ time: marker.ppq, name: marker.name })),
    ...doc.sections.map((section) => ({
      time: section.startPpq,
      name: `${SECTION_MARKER_PREFIX}${section.name}`,
    })),
  ].sort((a, b) => a.time - b.time);
  if (markers.length === 0) return null;
  return {
    name: 'Markers',
    attributes: { id: 'markers' },
    children: markers.map((marker): XmlElement => {
      return { name: 'Marker', attributes: { time: marker.time, name: marker.name } };
    }),
  };
}

/** Builds the Arrangement: automation, markers and one clip lane per track. */
function arrangementElement(
  doc: ProjectDocument,
  assets: Map<string, AudioAssetEntry>,
  tempoMap: NormalizedTempoMap,
): XmlElement {
  const vcaGainDbById = vcaGainDbByGroupId(doc);
  const children: XmlElement[] = [];
  const translated = translateTempoMapForExport(doc.tempoSegments, doc.timeSignatures);
  if (doc.timeSignatures.length > 1) {
    children.push(timeSignatureAutomationElement(translated.timeSignatures));
  }
  if (doc.tempoSegments.length > 1) {
    children.push(tempoAutomationElement(translated.tempoSegments));
  }
  const markers = markersElement(doc);
  if (markers) children.push(markers);

  const trackLanes = doc.tracks.map((track, trackIndex): XmlElement => {
    const automation = (track.automation ?? [])
      .filter((lane) => !isGroupPanAutomation(track.kind, lane))
      .map((lane) =>
        channelAutomationPointsElement(
          lane,
          String(trackIndex),
          `channel-${trackIndex}`,
          track.mixer,
          track.vcaId === undefined ? 0 : (vcaGainDbById.get(track.vcaId) ?? 0),
        ),
      )
      .filter((element): element is XmlElement => element !== null);
    const lane: XmlElement = {
      name: 'Lanes',
      attributes: { id: `lanes-${trackIndex}`, track: `track-${trackIndex}` },
      children: automation,
    };
    if (track.clips.length > 0) {
      lane.children = [
        ...(lane.children ?? []),
        {
          name: 'Clips',
          attributes: { id: `clips-${trackIndex}` },
          children: track.clips.map((clip, clipIndex) => {
            if (!isAudioClip(clip)) return midiClipElement(clip, trackIndex, clipIndex);
            const asset = clip.assetId !== undefined ? assets.get(clip.assetId) : undefined;
            if (!asset) {
              // Audio clip without a usable asset reference: placement only.
              return {
                name: 'Clip',
                attributes: { time: clip.startPpq, duration: clip.lengthPpq, name: clip.name },
              };
            }
            return audioClipElement(clip, asset, tempoMap, trackIndex, clipIndex);
          }),
        },
      ];
    }
    return lane;
  });
  const busLanes = (doc.mixer?.buses ?? []).flatMap((bus, busIndex): XmlElement[] => {
    const strip = bus.strip ?? NEUTRAL_STRIP;
    const automation = (bus.automation ?? [])
      .map((lane) =>
        channelAutomationPointsElement(lane, `bus-${busIndex}`, busChannelId(busIndex), strip),
      )
      .filter((element): element is XmlElement => element !== null);
    return automation.length > 0
      ? [
          {
            name: 'Lanes',
            attributes: { id: `bus-lanes-${busIndex}`, track: `bus-track-${busIndex}` },
            children: automation,
          },
        ]
      : [];
  });
  const masterAutomation = (doc.masterAutomation ?? [])
    .map((lane) =>
      channelAutomationPointsElement(lane, 'master', MASTER_CHANNEL_ID, doc.mixer?.master),
    )
    .filter((element): element is XmlElement => element !== null);
  const masterLanes: XmlElement[] =
    masterAutomation.length > 0
      ? [
          {
            name: 'Lanes',
            attributes: { id: 'master-lanes', track: 'master-track' },
            children: masterAutomation,
          },
        ]
      : [];
  children.push({
    name: 'Lanes',
    attributes: { id: 'arrangement-lanes', timeUnit: 'beats' },
    children: [...trackLanes, ...busLanes, ...masterLanes],
  });
  return { name: 'Arrangement', attributes: { id: 'arrangement' }, children };
}

/** Builds the complete project.xml root element. */
export function projectElement(
  doc: ProjectDocument,
  assets: Map<string, AudioAssetEntry>,
  applicationVersion: string,
  tempoMap: NormalizedTempoMap,
): XmlElement {
  return {
    name: 'Project',
    attributes: { version: DAWPROJECT_FORMAT_VERSION },
    children: [
      {
        name: 'Application',
        attributes: { name: APPLICATION_NAME, version: applicationVersion },
      },
      transportElement(doc),
      structureElement(doc),
      arrangementElement(doc, assets, tempoMap),
    ],
  };
}
