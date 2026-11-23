import { computed, type WritableComputedRef } from 'vue';
import { useProjectStore } from '@/project/store';

/** The snap menu's value: 'bar' for bar snapping, otherwise the grid division. */
export function useSnapChoice(): WritableComputedRef<number | 'bar'> {
  const store = useProjectStore();
  return computed<number | 'bar'>({
    get: () => (store.snapBar ? 'bar' : store.snapDivision),
    set: (value) => {
      store.snapBar = value === 'bar';
      if (value !== 'bar') store.snapDivision = value;
    },
  });
}
