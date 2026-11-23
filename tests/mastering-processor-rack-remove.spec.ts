import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, ref } from 'vue';
import { createDefaultMasteringChain } from '@/project/mixer';
import type { MasteringProcessorRack } from '@/ui/mastering/use-mastering-processor-rack';

let removeMasteringProcessor: (index: number) => void = () => {};
vi.mock('@/project/commands', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  removeMasteringProcessor: (index: number) => removeMasteringProcessor(index),
}));

const { useMasteringProcessorRack } = await import('@/ui/mastering/use-mastering-processor-rack');

function mountRack(): MasteringProcessorRack {
  const error = ref('');
  let rack: MasteringProcessorRack | undefined;
  mount(
    defineComponent({
      setup() {
        rack = useMasteringProcessorRack({
          chain: computed(() => createDefaultMasteringChain()),
          error,
          runCommand(action) {
            try {
              action();
              error.value = '';
            } catch (err) {
              error.value = String(err);
            }
          },
        });
        return () => null;
      },
    }),
  );
  if (!rack) throw new Error('rack not created');
  return rack;
}

describe('mastering processor rack removal', () => {
  beforeEach(() => {
    removeMasteringProcessor = () => {};
  });

  it('keeps the expanded slot when the removal fails', () => {
    removeMasteringProcessor = () => {
      throw new RangeError('stale slot');
    };
    const rack = mountRack();
    rack.expandedIndex.value = 2;
    rack.onRemove(1);
    expect(rack.expandedIndex.value).toBe(2);
  });

  it('shifts the expanded slot past a removed earlier slot', () => {
    const rack = mountRack();
    rack.expandedIndex.value = 2;
    rack.onRemove(1);
    expect(rack.expandedIndex.value).toBe(1);
    rack.onRemove(1);
    expect(rack.expandedIndex.value).toBeNull();
  });
});
