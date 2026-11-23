import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InfoLine from '@/components/piano-roll/InfoLine.vue';
import { addNote, clearHistory, setSelection } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { vTooltip } from '@/ui/tooltip';
import { enterKey } from './ime-test-helpers';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('InfoLine Enter with an IME', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    setSelection([addNote({ pitch: 60, startPpq: 0, durationPpq: 1 })]);
  });

  function field() {
    const wrapper = mount(InfoLine, { global: { directives: { tooltip: vTooltip } } });
    const input = wrapper.find<HTMLInputElement>('.info-line__input');
    return { input, blur: vi.spyOn(input.element, 'blur') };
  }

  it('does not blur the field when Enter confirms a composition', () => {
    const { input, blur } = field();
    input.element.dispatchEvent(enterKey(true));
    expect(blur).not.toHaveBeenCalled();
  });

  it('blurs the field on a plain Enter', () => {
    const { input, blur } = field();
    input.element.dispatchEvent(enterKey(false));
    expect(blur).toHaveBeenCalledTimes(1);
  });
});
