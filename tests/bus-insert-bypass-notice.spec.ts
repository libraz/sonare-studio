import { describe, expect, it } from 'vitest';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';
import { readSource } from './helpers/source-text';

const insertRackSource = readSource('src/components/mixer/InsertRack.vue');

describe('bus insert bypass notice', () => {
  it('uses a bus-specific tooltip because bus bypass rebuilds the bus chain', () => {
    expect(insertRackSource).toContain('function insertPowerTooltip');
    expect(insertRackSource).toContain('isMixerBusStripTarget(props.target)');
    expect(insertRackSource).toContain('t.value.shell.inserts.busBypass');
    expect(insertRackSource).toContain('t.value.shell.inserts.busEnable');
    expect(insertRackSource).toContain('v-tooltip="insertPowerTooltip(slot)"');
  });

  // Read the key the component reads, not the file the string happens to sit
  // in: what matters is the wording the tooltip resolves to.
  it('has localized bus bypass copy that mentions the chain rebuild', () => {
    expect(en.shell.inserts.busBypass).toBe('Bypass return-bus insert (rebuilds the bus chain)');
    expect(en.shell.inserts.busEnable).toBe('Enable return-bus insert (rebuilds the bus chain)');
    expect(ja.shell.inserts.busBypass).toBe(
      'return bus のインサートをバイパス（bus チェインを再構築）',
    );
    expect(ja.shell.inserts.busEnable).toBe(
      'return bus のインサートを有効化（bus チェインを再構築）',
    );
  });
});
