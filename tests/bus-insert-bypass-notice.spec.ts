import { describe, expect, it } from 'vitest';
import insertRackSource from '@/components/mixer/InsertRack.vue?raw';
import enSource from '@/ui/i18n/en.ts?raw';
import jaSource from '@/ui/i18n/ja.ts?raw';

describe('bus insert bypass notice', () => {
  it('uses a bus-specific tooltip because bus bypass rebuilds the bus chain', () => {
    expect(insertRackSource).toContain('function insertPowerTooltip');
    expect(insertRackSource).toContain('isMixerBusStripTarget(props.target)');
    expect(insertRackSource).toContain('t.value.shell.inserts.busBypass');
    expect(insertRackSource).toContain('t.value.shell.inserts.busEnable');
    expect(insertRackSource).toContain('v-tooltip="insertPowerTooltip(slot)"');
  });

  it('has localized bus bypass copy that mentions the chain rebuild', () => {
    expect(enSource).toContain('Bypass return-bus insert (rebuilds the bus chain)');
    expect(enSource).toContain('Enable return-bus insert (rebuilds the bus chain)');
    expect(jaSource).toContain('return bus のインサートをバイパス（bus チェインを再構築）');
    expect(jaSource).toContain('return bus のインサートを有効化（bus チェインを再構築）');
  });
});
