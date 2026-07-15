export type OperationIdentityValue = string | number | null;

/** Stable identity captured before an asynchronous operation starts. */
export interface OperationIdentity {
  projectId: OperationIdentityValue;
  targetId: OperationIdentityValue;
  revision: OperationIdentityValue;
}

/** Immutable operation token revalidated after every await and before commit. */
export interface OperationToken extends OperationIdentity {
  operationId: number;
  signal: AbortSignal;
  /** Reflects disposal/invalidation of the owning generation scope. */
  readonly disposed: boolean;
}

function sameIdentity(a: OperationIdentity, b: OperationIdentity): boolean {
  return a.projectId === b.projectId && a.targetId === b.targetId && a.revision === b.revision;
}

/** Shared generation/cancellation primitive for async UI and worker flows. */
export class OperationGeneration {
  private operationId = 0;
  private controller: AbortController | null = null;
  private disposedState = false;

  begin(identity: OperationIdentity): OperationToken {
    if (this.disposedState) throw new Error('Operation generation is disposed');
    this.invalidate(new DOMException('Operation superseded.', 'AbortError'));
    const operationId = this.operationId;
    const controller = new AbortController();
    this.controller = controller;
    const owner = this;
    return Object.freeze({
      ...identity,
      operationId,
      signal: controller.signal,
      get disposed() {
        return owner.disposedState || controller.signal.aborted;
      },
    });
  }

  isCurrent(token: OperationToken, identity?: OperationIdentity): boolean {
    return (
      !this.disposedState &&
      !token.signal.aborted &&
      token.operationId === this.operationId &&
      (identity === undefined || sameIdentity(token, identity))
    );
  }

  invalidate(reason: unknown = new DOMException('Operation invalidated.', 'AbortError')): void {
    this.operationId += 1;
    this.controller?.abort(reason);
    this.controller = null;
  }

  dispose(reason: unknown = new DOMException('Operation disposed.', 'AbortError')): void {
    if (this.disposedState) return;
    this.disposedState = true;
    this.invalidate(reason);
  }

  get disposed(): boolean {
    return this.disposedState;
  }
}
