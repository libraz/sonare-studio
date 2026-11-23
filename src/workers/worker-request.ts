/** Shared request loop for one-shot workers: validate, run, always reply with a typed result. */

export interface WorkerRequestHandler<Req, Res> {
  /** Type guard over the untrusted structured-clone payload. */
  validate(value: unknown): value is Req;
  /** Message sent back when `validate` rejects the payload. */
  invalidMessage: string;
  /** Builds the worker's typed error reply from anything thrown, including the invalid-request error. */
  errorReply(error: unknown): Res;
  /** Performs the work; may be async. Anything it throws or rejects becomes `errorReply`. */
  handle(request: Req, post: (reply: Res, transfer?: Transferable[]) => void): void | Promise<void>;
}

/** Registers the message listener; every request ends in a reply, never a silent return. */
export function serveWorkerRequests<Req, Res>(handler: WorkerRequestHandler<Req, Res>): void {
  const post = (reply: Res, transfer: Transferable[] = []): void => postMessage(reply, transfer);
  const fail = (error: unknown): void => post(handler.errorReply(error));
  // A request that could not be deserialized still gets a reply, or its caller waits forever.
  self.addEventListener('messageerror', () => fail(new Error('Worker request could not be read')));
  self.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!handler.validate(event.data)) {
      fail(new Error(handler.invalidMessage));
      return;
    }
    try {
      Promise.resolve(handler.handle(event.data, post)).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}

/** Shared plain-object check for request validators. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True for a list of Float32Array channels. */
export function isChannelList(value: unknown): value is Float32Array[] {
  return Array.isArray(value) && value.every((c) => c instanceof Float32Array);
}
