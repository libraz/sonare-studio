/** Identifiers and defaults the DAWproject exporter, importer and sidecar must agree on. */

/** Id of the master channel (regular channels name it as their destination). */
export const MASTER_CHANNEL_ID = 'master-channel';

/** Channel id the exporter gives the bus at `index`. */
export function busChannelId(index: number): string {
  return `bus-channel-${index}`;
}

/** Vendor-scoped Target prefix for automation DAWproject cannot name natively. */
export const SONARE_AUTOMATION_PARAMETER_PREFIX = 'sonare-automation:';

/** Shortest length an imported clip or note may take, in PPQ. */
export const MIN_IMPORTED_LENGTH_PPQ = 0.0001;

/** Clip length assumed when the file gives none, in PPQ. */
export const DEFAULT_IMPORTED_CLIP_LENGTH_PPQ = 4;

/** Sample rate the importer assigns, since project.xml has no project rate. */
export const IMPORTED_SAMPLE_RATE = 48000;
