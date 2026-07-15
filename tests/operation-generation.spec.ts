import { describe, expect, it } from 'vitest';
import { OperationGeneration } from '@/lib/operation-generation';

describe('OperationGeneration', () => {
  it('supersedes and aborts the previous immutable token', () => {
    const operations = new OperationGeneration();
    const first = operations.begin({ projectId: 1, targetId: 'clip-a', revision: 3 });
    const second = operations.begin({ projectId: 1, targetId: 'clip-b', revision: 4 });

    expect(first.signal.aborted).toBe(true);
    expect(first.disposed).toBe(true);
    expect(operations.isCurrent(first)).toBe(false);
    expect(operations.isCurrent(second)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('revalidates project, target, and revision at commit time', () => {
    const operations = new OperationGeneration();
    const identity = { projectId: 'project-a', targetId: 7, revision: 'r1' };
    const token = operations.begin(identity);

    expect(operations.isCurrent(token, identity)).toBe(true);
    expect(operations.isCurrent(token, { ...identity, targetId: 8 })).toBe(false);
    expect(operations.isCurrent(token, { ...identity, revision: 'r2' })).toBe(false);
  });

  it('invalidates active work permanently on dispose', () => {
    const operations = new OperationGeneration();
    const token = operations.begin({ projectId: 1, targetId: null, revision: 0 });
    operations.dispose();

    expect(token.signal.aborted).toBe(true);
    expect(operations.isCurrent(token)).toBe(false);
    expect(() => operations.begin({ projectId: 1, targetId: null, revision: 1 })).toThrow(
      /disposed/,
    );
  });
});
