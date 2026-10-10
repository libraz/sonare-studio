<script setup lang="ts">
/**
 * Multi-timbral channel map for an SF2 (GM/GS module) instrument. Each MIDI
 * channel can override the track's default program; channel 10 (index 9) is a
 * percussion channel whose bank selects a GM2 drum/SFX kit. Channels left
 * unset inherit the track-level bank/program.
 */
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import type { Sf2ChannelProgram } from '@/project/instrument';
import { getWasmModule } from '@/project/store';
import { clampProgram, normalizeChannelMap, SF2_DRUM_CHANNEL } from '@/ui/devices/sf2-model';
import { useI18n } from '@/ui/i18n';
import { GM2_DRUM_BANK_MSB, gm2DrumBank } from '@/ui/step-sequencer/drum-map';

const props = defineProps<{
  /** Current per-channel program overrides. */
  modelValue: Sf2ChannelProgram[];
  /** Track-level bank inherited by newly enabled melodic channels. */
  defaultBank: number;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: Sf2ChannelProgram[]];
}>();

const { t } = useI18n();

interface WasmNames {
  Project?: {
    gmInstrumentName?: (program: number) => string | null;
    gm2DrumSetName?: (bankLsb: number) => string | null;
  };
}

function wasmProject(): WasmNames['Project'] {
  try {
    return (getWasmModule() as unknown as WasmNames).Project;
  } catch {
    return undefined;
  }
}

/** All 16 MIDI channels, in order. */
const CHANNELS = Array.from({ length: 16 }, (_, channel) => channel);

/** Program name for a melodic channel program (GM set). */
function programName(program: number): string {
  return wasmProject()?.gmInstrumentName?.(program) ?? `Program ${program}`;
}

/** GM2 drum/SFX kits the loaded module names, in bank-LSB order. */
const drumKitOptions = computed(() => {
  const project = wasmProject();
  const options: { value: string; label: string }[] = [];
  for (let lsb = 0; lsb <= 127; lsb++) {
    const name = project?.gm2DrumSetName?.(lsb);
    if (name) options.push({ value: String(lsb), label: name });
  }
  // Standard kit fallback so the control is never empty when the module lacks
  // the naming helpers.
  if (options.length === 0) options.push({ value: '0', label: t.value.shell.devicesPanel.drumKit });
  return options;
});

function entryFor(channel: number): Sf2ChannelProgram | undefined {
  return props.modelValue.find((entry) => entry.channel === channel);
}

function isEnabled(channel: number): boolean {
  return entryFor(channel) !== undefined;
}

/** The kit LSB currently set on the drum channel (defaults to Standard = 0). */
const drumKitLsb = computed(() => {
  const bank = entryFor(SF2_DRUM_CHANNEL)?.bank;
  if (bank === undefined) return 0;
  return bank & 0x7f;
});

function commit(channel: number, next: Sf2ChannelProgram | null): void {
  const rest = props.modelValue.filter((entry) => entry.channel !== channel);
  const map = next ? [...rest, next] : rest;
  emit('update:modelValue', normalizeChannelMap(map));
}

function toggleChannel(channel: number, enabled: boolean): void {
  if (!enabled) {
    commit(channel, null);
    return;
  }
  if (channel === SF2_DRUM_CHANNEL) {
    commit(channel, { channel, bank: gm2DrumBank(0), program: 0 });
  } else {
    commit(channel, { channel, bank: props.defaultBank, program: 0 });
  }
}

function setProgram(channel: number, raw: number): void {
  commit(channel, {
    channel,
    bank: entryFor(channel)?.bank ?? props.defaultBank,
    program: clampProgram(raw),
  });
}

function setBank(channel: number, raw: number): void {
  const bank = Number.isFinite(raw) ? Math.max(0, Math.min(16383, Math.round(raw))) : 0;
  commit(channel, { channel, bank, program: entryFor(channel)?.program ?? 0 });
}

function setDrumKit(channel: number, kitLsbValue: string): void {
  const kitLsb = Number(kitLsbValue);
  commit(channel, { channel, bank: gm2DrumBank(Number.isFinite(kitLsb) ? kitLsb : 0), program: 0 });
}

function channelLabel(channel: number): string {
  return `${t.value.shell.devicesPanel.channelShort}${channel + 1}`;
}
</script>

<template>
  <section class="sf2-channel-map">
    <div class="sf2-channel-map-head">
      <span class="sf2-channel-map-title">{{ t.shell.devicesPanel.channelMap }}</span>
      <span class="sf2-channel-map-hint">{{ t.shell.devicesPanel.channelMapHint }}</span>
    </div>
    <ul class="sf2-channel-rows">
      <li
        v-for="channel in CHANNELS"
        :key="channel"
        class="sf2-channel-row"
        :class="{ drum: channel === SF2_DRUM_CHANNEL, active: isEnabled(channel) }"
      >
        <label class="sf2-channel-toggle">
          <input
            type="checkbox"
            :checked="isEnabled(channel)"
            @change="toggleChannel(channel, ($event.target as HTMLInputElement).checked)"
          />
          <span class="sf2-channel-name">{{ channelLabel(channel) }}</span>
          <span v-if="channel === SF2_DRUM_CHANNEL" class="sf2-channel-tag">
            {{ t.shell.devicesPanel.drumChannel }}
          </span>
        </label>

        <template v-if="isEnabled(channel)">
          <div v-if="channel === SF2_DRUM_CHANNEL" class="sf2-channel-control">
            <SelectMenu
              :model-value="String(drumKitLsb)"
              :options="drumKitOptions"
              size="sm"
              :aria-label="t.shell.devicesPanel.drumKit"
              @update:model-value="(value: string) => setDrumKit(channel, value)"
            />
          </div>
          <div v-else class="sf2-channel-control">
            <input
              class="sf2-channel-bank"
              type="number"
              min="0"
              max="16383"
              :value="entryFor(channel)?.bank ?? defaultBank"
              :aria-label="t.shell.devicesPanel.bank"
              @input="setBank(channel, Number(($event.target as HTMLInputElement).value))"
            />
            <input
              class="sf2-channel-program"
              type="number"
              min="0"
              max="127"
              :value="entryFor(channel)?.program ?? 0"
              :aria-label="t.shell.devicesPanel.program"
              @input="setProgram(channel, Number(($event.target as HTMLInputElement).value))"
            />
            <span class="sf2-channel-program-name">{{
              programName(entryFor(channel)?.program ?? 0)
            }}</span>
          </div>
        </template>
        <span v-else class="sf2-channel-inherit">{{ t.shell.devicesPanel.channelInherit }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sf2-channel-map {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sf2-channel-map-head {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.sf2-channel-map-title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-1);
}

.sf2-channel-map-hint {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.sf2-channel-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Fixed height so enabling/disabling rows scrolls internally instead of
     resizing the picker panel. */
  max-block-size: 15rem;
  overflow-y: auto;
}

.sf2-channel-row {
  display: grid;
  grid-template-columns: minmax(6.5rem, auto) 1fr;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  border: 1px solid transparent;
  border-radius: 6px;
  transition:
    background var(--dur-2) var(--ease-out),
    border-color var(--dur-2) var(--ease-out);
}

.sf2-channel-row.active {
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.sf2-channel-row.drum.active {
  border-color: color-mix(in srgb, var(--warning) 32%, transparent);
  background: color-mix(in srgb, var(--warning) 8%, transparent);
}

.sf2-channel-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  min-inline-size: 0;
}

.sf2-channel-name {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
}

.sf2-channel-tag {
  font-size: var(--fs-2xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.sf2-channel-control {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-inline-size: 0;
}

/* Bank and program sit side by side in one row, so they share a treatment;
 * only the width differs, sized to each field's digit count (bank 0–16383,
 * program 0–127). */
.sf2-channel-bank,
.sf2-channel-program {
  padding: 0.2rem 0.3rem;
  font-variant-numeric: tabular-nums;
}

.sf2-channel-bank {
  inline-size: 4.2rem;
}

.sf2-channel-program {
  inline-size: 3.4rem;
}

.sf2-channel-program-name {
  font-size: var(--fs-xs);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sf2-channel-inherit {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
</style>
