import { describe, expect, it, vi } from 'vitest';
import { OperationGeneration } from '@/lib/operation-generation';

const projectMocks = vi.hoisted(() => ({
  current: {} as object,
  getProject: vi.fn(),
}));

vi.mock('@/project/store', () => ({
  getProject: projectMocks.getProject,
}));

import {
  assertProjectOperationCurrent,
  beginProjectOperation,
  isProjectOperationCurrent,
  projectOperationIdentity,
  StaleProjectOperationError,
} from '@/project/operation';

describe('project asynchronous operation ownership', () => {
  it('rejects a commit after the native project owner or operation generation changes', () => {
    const store = { documentGeneration: 4 } as never;
    projectMocks.current = {};
    projectMocks.getProject.mockImplementation(() => projectMocks.current);
    const operations = new OperationGeneration();
    const snapshot = beginProjectOperation(operations, store, 7, 3);

    expect(projectOperationIdentity(store, 7, 3)).toEqual({
      projectId: 4,
      targetId: 7,
      revision: 3,
    });
    expect(isProjectOperationCurrent(operations, snapshot, store, 7, 3)).toBe(true);

    projectMocks.current = {};
    expect(isProjectOperationCurrent(operations, snapshot, store, 7, 3)).toBe(false);
    expect(() => assertProjectOperationCurrent(operations, snapshot, store, 7, 3)).toThrow(
      StaleProjectOperationError,
    );

    const current = beginProjectOperation(operations, store, 7, 4);
    expect(isProjectOperationCurrent(operations, snapshot, store, 7, 3)).toBe(false);
    expect(isProjectOperationCurrent(operations, current, store, 7, 4)).toBe(true);
  });
});
