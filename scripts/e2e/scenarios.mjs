/**
 * The scenario running order.
 *
 * Most scenarios share one page and build on each other, so the order is part of
 * the contract rather than a listing convenience: the demo has to be open
 * before anything can edit it, an asset has to be imported before a clip can
 * carry it, and the export scenarios read what the rest of the run produced.
 * Self-contained persistence and production journeys create their own contexts.
 */

import * as audio_alignment from './scenarios/audio-alignment.mjs';
import * as audio_analysis from './scenarios/audio-analysis.mjs';
import * as audio_arrangement_edit from './scenarios/audio-arrangement-edit.mjs';
import * as audio_edit_to_master from './scenarios/audio-edit-to-master.mjs';
import * as audio_import from './scenarios/audio-import.mjs';
import * as audio_record from './scenarios/audio-record.mjs';
import * as audio_to_midi_production from './scenarios/audio-to-midi-production.mjs';
import * as audio_transcribe from './scenarios/audio-transcribe.mjs';
import * as automation_ramp from './scenarios/automation-ramp.mjs';
import * as automation_write from './scenarios/automation-write.mjs';
import * as autosave_restore from './scenarios/autosave-restore.mjs';
import * as baroque_organ_compose from './scenarios/baroque-organ-compose.mjs';
import * as boot from './scenarios/boot.mjs';
import * as bus_master_sidechain from './scenarios/bus-master-sidechain.mjs';
import * as bus_routing from './scenarios/bus-routing.mjs';
import * as bus_strips from './scenarios/bus-strips.mjs';
import * as cc_lane from './scenarios/cc-lane.mjs';
import * as composition_flow from './scenarios/composition-flow.mjs';
import * as cycle_recording from './scenarios/cycle-recording.mjs';
import * as dawproject_roundtrip from './scenarios/dawproject-roundtrip.mjs';
import * as drum_kit from './scenarios/drum-kit.mjs';
import * as export_dawproject from './scenarios/export-dawproject.mjs';
import * as export_dialog from './scenarios/export-dialog.mjs';
import * as export_equivalence from './scenarios/export-equivalence.mjs';
import * as export_formats from './scenarios/export-formats.mjs';
import * as export_midi from './scenarios/export-midi.mjs';
import * as expression_maps from './scenarios/expression-maps.mjs';
import * as first_play_mixer from './scenarios/first-play-mixer.mjs';
import * as freeze_bounce from './scenarios/freeze-bounce.mjs';
import * as freeze_bounce_ui from './scenarios/freeze-bounce-ui.mjs';
import * as generation_seed from './scenarios/generation-seed.mjs';
import * as gm_voice from './scenarios/gm-voice.mjs';
import * as groove from './scenarios/groove.mjs';
import * as gs_efx_sf2 from './scenarios/gs-efx-sf2.mjs';
import * as guitar_amp_di from './scenarios/guitar-amp-di.mjs';
import * as imported_song_edit from './scenarios/imported-song-edit.mjs';
import * as input_monitor from './scenarios/input-monitor.mjs';
import * as jpop_long_form from './scenarios/jpop-long-form.mjs';
import * as jpop_section_variations from './scenarios/jpop-section-variations.mjs';
import * as lane_meters from './scenarios/lane-meters.mjs';
import * as language_ja from './scenarios/language-ja.mjs';
import * as layouts from './scenarios/layouts.mjs';
import * as long_master_export_preflight from './scenarios/long-master-export-preflight.mjs';
import * as loudness from './scenarios/loudness.mjs';
import * as master_fader from './scenarios/master-fader.mjs';
import * as master_limiter from './scenarios/master-limiter.mjs';
import * as master_meter_readouts from './scenarios/master-meter-readouts.mjs';
import * as mastering_chain from './scenarios/mastering-chain.mjs';
import * as meter_map from './scenarios/meter-map.mjs';
import * as midi_clip_envelope from './scenarios/midi-clip-envelope.mjs';
import * as midi_fx from './scenarios/midi-fx.mjs';
import * as midi2_clip_import from './scenarios/midi2-clip-import.mjs';
import * as mix_suggestion from './scenarios/mix-suggestion.mjs';
import * as mixer_snapshots from './scenarios/mixer-snapshots.mjs';
import * as mixer_strips from './scenarios/mixer-strips.mjs';
import * as multi_timbral from './scenarios/multi-timbral.mjs';
import * as multitrack_stems_handoff from './scenarios/multitrack-stems-handoff.mjs';
import * as musicxml_roundtrip from './scenarios/musicxml-roundtrip.mjs';
import * as opfs_restore from './scenarios/opfs-restore.mjs';
import * as ornaments from './scenarios/ornaments.mjs';
import * as piano_roll from './scenarios/piano-roll.mjs';
import * as placement_guide from './scenarios/placement-guide.mjs';
import * as pop_arrangement from './scenarios/pop-arrangement.mjs';
import * as pop_audio_adjust from './scenarios/pop-audio-adjust.mjs';
import * as pop_clipboard from './scenarios/pop-clipboard.mjs';
import * as portable_project from './scenarios/portable-project.mjs';
import * as project_revisions from './scenarios/project-revisions.mjs';
import * as project_save_reopen from './scenarios/project-save-reopen.mjs';
import * as pwa_offline from './scenarios/pwa-offline.mjs';
import * as rack_inserts from './scenarios/rack-inserts.mjs';
import * as rack_instrument from './scenarios/rack-instrument.mjs';
import * as realtime_midi from './scenarios/realtime-midi.mjs';
import * as realtime_mute from './scenarios/realtime-mute.mjs';
import * as sample_editor_flow from './scenarios/sample-editor-flow.mjs';
import * as score from './scenarios/score.mjs';
import * as score_annotations from './scenarios/score-annotations.mjs';
import * as score_chord_symbols from './scenarios/score-chord-symbols.mjs';
import * as score_print_pdf from './scenarios/score-print-pdf.mjs';
import * as secondary_dominant_guidance from './scenarios/secondary-dominant-guidance.mjs';
import * as shortcut_help from './scenarios/shortcut-help.mjs';
import * as shortcut_persistence from './scenarios/shortcut-persistence.mjs';
import * as shortcut_remap from './scenarios/shortcut-remap.mjs';
import * as sidechain from './scenarios/sidechain.mjs';
import * as stem_separation from './scenarios/stem-separation.mjs';
import * as step_input from './scenarios/step-input.mjs';
import * as step_sequencer from './scenarios/step-sequencer.mjs';
import * as strip_sends from './scenarios/strip-sends.mjs';
import * as takes_comping from './scenarios/takes-comping.mjs';
import * as tempo_map from './scenarios/tempo-map.mjs';
import * as tempo_map_edit from './scenarios/tempo-map-edit.mjs';
import * as theory_hover from './scenarios/theory-hover.mjs';
import * as timeline_markers from './scenarios/timeline-markers.mjs';
import * as track_and_clip from './scenarios/track-and-clip.mjs';
import * as vca_strips from './scenarios/vca-strips.mjs';
import * as warp from './scenarios/warp.mjs';
import * as warp_toggle from './scenarios/warp-toggle.mjs';

export const scenarios = [
  boot,
  midi_clip_envelope,
  theory_hover,
  piano_roll,
  score,
  score_annotations,
  score_print_pdf,
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
  mix_suggestion,
  realtime_mute,
  rack_instrument,
  rack_inserts,
  master_limiter,
  step_sequencer,
  realtime_midi,
  lane_meters,
  tempo_map,
  tempo_map_edit,
  meter_map,
  timeline_markers,
  automation_ramp,
  automation_write,
  export_equivalence,
  cycle_recording,
  sidechain,
  bus_routing,
  bus_master_sidechain,
  warp,
  warp_toggle,
  freeze_bounce,
  mastering_chain,
  long_master_export_preflight,
  export_dialog,
  export_midi,
  export_dawproject,
  // Each adds tracks of its own and removes them again.
  ornaments,
  midi_fx,
  cc_lane,
  gm_voice,
  drum_kit,
  expression_maps,
  groove,
  step_input,
  vca_strips,
  // Last: it leaves its own tracks, an empty active clip and a far playhead.
  placement_guide,
  // Standalone new-project journey, kept last because it replaces the demo.
  composition_flow,
  pop_arrangement,
  pop_clipboard,
  pop_audio_adjust,
  project_save_reopen,
  imported_song_edit,
  secondary_dominant_guidance,
  audio_alignment,
  audio_arrangement_edit,
  dawproject_roundtrip,
  jpop_long_form,
  jpop_section_variations,
  baroque_organ_compose,
  guitar_amp_di,
  gs_efx_sf2,
  audio_transcribe,
  // Self-contained journeys; portable projects and revisions use fresh storage.
  sample_editor_flow,
  mixer_snapshots,
  portable_project,
  project_revisions,
  // DAW production journeys each start with independent browser storage.
  audio_to_midi_production,
  multitrack_stems_handoff,
  audio_edit_to_master,
  // Each opens its own browser context: they replace the project, install a
  // service worker or change the stored language.
  multi_timbral,
  score_chord_symbols,
  generation_seed,
  strip_sends,
  bus_strips,
  master_meter_readouts,
  first_play_mixer,
  master_fader,
  loudness,
  takes_comping,
  audio_analysis,
  export_formats,
  autosave_restore,
  freeze_bounce_ui,
  musicxml_roundtrip,
  stem_separation,
  midi2_clip_import,
  pwa_offline,
  language_ja,
];
