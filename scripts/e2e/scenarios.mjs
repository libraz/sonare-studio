/**
 * The scenario running order.
 *
 * Scenarios share one page and build on each other, so the order is part of
 * the contract rather than a listing convenience: the demo has to be open
 * before anything can edit it, an asset has to be imported before a clip can
 * carry it, and the export scenarios read what the rest of the run produced.
 */

import * as audio_import from './scenarios/audio-import.mjs';
import * as audio_record from './scenarios/audio-record.mjs';
import * as automation_ramp from './scenarios/automation-ramp.mjs';
import * as automation_write from './scenarios/automation-write.mjs';
import * as boot from './scenarios/boot.mjs';
import * as composition_flow from './scenarios/composition-flow.mjs';
import * as cycle_recording from './scenarios/cycle-recording.mjs';
import * as export_dawproject from './scenarios/export-dawproject.mjs';
import * as export_dialog from './scenarios/export-dialog.mjs';
import * as export_equivalence from './scenarios/export-equivalence.mjs';
import * as export_midi from './scenarios/export-midi.mjs';
import * as freeze_bounce from './scenarios/freeze-bounce.mjs';
import * as input_monitor from './scenarios/input-monitor.mjs';
import * as lane_meters from './scenarios/lane-meters.mjs';
import * as layouts from './scenarios/layouts.mjs';
import * as master_limiter from './scenarios/master-limiter.mjs';
import * as mastering_chain from './scenarios/mastering-chain.mjs';
import * as mixer_strips from './scenarios/mixer-strips.mjs';
import * as opfs_restore from './scenarios/opfs-restore.mjs';
import * as piano_roll from './scenarios/piano-roll.mjs';
import * as placement_guide from './scenarios/placement-guide.mjs';
import * as rack_inserts from './scenarios/rack-inserts.mjs';
import * as rack_instrument from './scenarios/rack-instrument.mjs';
import * as realtime_midi from './scenarios/realtime-midi.mjs';
import * as realtime_mute from './scenarios/realtime-mute.mjs';
import * as score from './scenarios/score.mjs';
import * as score_annotations from './scenarios/score-annotations.mjs';
import * as shortcut_help from './scenarios/shortcut-help.mjs';
import * as shortcut_persistence from './scenarios/shortcut-persistence.mjs';
import * as shortcut_remap from './scenarios/shortcut-remap.mjs';
import * as sidechain from './scenarios/sidechain.mjs';
import * as step_sequencer from './scenarios/step-sequencer.mjs';
import * as tempo_map from './scenarios/tempo-map.mjs';
import * as track_and_clip from './scenarios/track-and-clip.mjs';
import * as warp from './scenarios/warp.mjs';

export const scenarios = [
  boot,
  piano_roll,
  score,
  score_annotations,
  shortcut_help,
  shortcut_remap,
  layouts,
  track_and_clip,
  opfs_restore,
  shortcut_persistence,
  audio_import,
  audio_record,
  input_monitor,
  mixer_strips,
  realtime_mute,
  rack_instrument,
  rack_inserts,
  master_limiter,
  step_sequencer,
  realtime_midi,
  lane_meters,
  tempo_map,
  automation_ramp,
  automation_write,
  export_equivalence,
  cycle_recording,
  sidechain,
  warp,
  freeze_bounce,
  mastering_chain,
  export_dialog,
  export_midi,
  export_dawproject,
  // Last: it leaves its own tracks, an empty active clip and a far playhead.
  placement_guide,
  // Standalone new-project journey, kept last because it replaces the demo.
  composition_flow,
];
