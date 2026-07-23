const MIB = 1024 * 1024;

export const MAX_AUDIO_SAMPLE_RATE = 384_000;
export const MAX_AUDIO_CHANNELS = 32;
export const MAX_AUDIO_SAMPLE_BYTES = 256 * MIB;
export const MAX_AUDIO_SAMPLES = MAX_AUDIO_SAMPLE_BYTES / Float32Array.BYTES_PER_ELEMENT;

/** Largest Standard MIDI File accepted before invoking the wasm parser. */
export const MAX_SMF_FILE_BYTES = 32 * MIB;

export const MAX_PROJECT_ARCHIVE_COMPRESSED_BYTES = 256 * MIB;
export const MAX_PROJECT_ARCHIVE_EXPANDED_BYTES = 512 * MIB;
export const MAX_PROJECT_ARCHIVE_ENTRY_BYTES = 256 * MIB;
export const MAX_PROJECT_ARCHIVE_ENTRIES = 4096;

export const MAX_BACKUP_ARCHIVE_COMPRESSED_BYTES = 512 * MIB;
export const MAX_BACKUP_OUTER_EXPANDED_BYTES = 512 * MIB;
export const MAX_BACKUP_TOTAL_EXPANDED_BYTES = 768 * MIB;
export const MAX_BACKUP_ARCHIVE_ENTRY_BYTES = 256 * MIB;
export const MAX_BACKUP_ARCHIVE_ENTRIES = 20_000;

export const MAX_DAWPROJECT_ARCHIVE_BYTES = 256 * MIB;
// Keep the picker limit aligned with the largest PCM payload we can persist.
// Compressed formats can still decode larger, so decodeAndIngest enforces the
// corresponding decoded-sample cap before copying channel data.
export const MAX_EXTERNAL_AUDIO_FILE_BYTES = MAX_AUDIO_SAMPLE_BYTES;
export const MAX_EXTERNAL_AUDIO_TOTAL_BYTES = 1024 * MIB;
