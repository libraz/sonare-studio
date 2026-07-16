import type {
  OperationGeneration,
  OperationIdentity,
  OperationIdentityValue,
  OperationToken,
} from '@/lib/operation-generation';
import { getProject, type useProjectStore } from './store';

type ProjectStore = ReturnType<typeof useProjectStore>;
type NativeProject = ReturnType<typeof getProject>;

/** Captured owner of one asynchronous command that may mutate project state. */
export interface ProjectOperationSnapshot {
  project: NativeProject;
  token: OperationToken;
}

/** Raised when an async command no longer owns the open project/target. */
export class StaleProjectOperationError extends Error {
  constructor(message = 'Project operation was superseded before commit') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Builds the identity shared by project-bound asynchronous commands. */
export function projectOperationIdentity(
  store: ProjectStore,
  targetId: OperationIdentityValue,
  revision: OperationIdentityValue,
): OperationIdentity {
  return { projectId: store.documentGeneration, targetId, revision };
}

/** Starts one operation and captures the exact native Project it owns. */
export function beginProjectOperation(
  operations: OperationGeneration,
  store: ProjectStore,
  targetId: OperationIdentityValue,
  revision: OperationIdentityValue,
): ProjectOperationSnapshot {
  return {
    project: getProject(),
    token: operations.begin(projectOperationIdentity(store, targetId, revision)),
  };
}

/** True only while generation, document, target revision and native Project match. */
export function isProjectOperationCurrent(
  operations: OperationGeneration,
  snapshot: ProjectOperationSnapshot,
  store: ProjectStore,
  targetId: OperationIdentityValue,
  revision: OperationIdentityValue,
): boolean {
  try {
    return (
      getProject() === snapshot.project &&
      operations.isCurrent(snapshot.token, projectOperationIdentity(store, targetId, revision))
    );
  } catch {
    return false;
  }
}

/** Throws a typed cancellation error when ownership has changed. */
export function assertProjectOperationCurrent(
  operations: OperationGeneration,
  snapshot: ProjectOperationSnapshot,
  store: ProjectStore,
  targetId: OperationIdentityValue,
  revision: OperationIdentityValue,
): void {
  if (!isProjectOperationCurrent(operations, snapshot, store, targetId, revision)) {
    throw new StaleProjectOperationError();
  }
}
