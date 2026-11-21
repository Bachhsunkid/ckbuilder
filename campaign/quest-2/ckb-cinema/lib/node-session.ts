/** Own a saved browser node exclusively until its runtime has fully stopped. */
type RunningNode = { readonly isRunning: boolean; stop(): Promise<unknown> };
type LockProvider = Pick<LockManager, 'request'>;

export class DuplicateNodeSessionError extends Error {
  constructor() {
    super('Node already in use: this saved node is running in another tutorial tab. Close that tab to stop its node session, then retry here. Keep only one active tutorial tab for this saved node.');
    this.name = 'DuplicateNodeSessionError';
  }
}

export class PeerHandshakeTimeoutError extends Error {
  constructor(retryAction: string) {
    super(`Peer handshake timed out: the node is running, but the public peer did not finish connecting. Check your network connection, then select ${retryAction} to retry. If it keeps timing out, the public peer may be unavailable; try again later.`);
    this.name = 'PeerHandshakeTimeoutError';
  }
}

export function createBrowserNodeSession(manager: LockProvider | null = navigator.locks ?? null) {
  let release: (() => Promise<void>) | undefined;
  let current: RunningNode | undefined;
  let operation: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let disposed = false;
  let lockedProfile: string | undefined;

  async function acquire(profileKey: string) {
    if (!manager) throw new Error('This browser cannot coordinate saved nodes across tabs. Use a browser with Web Locks support to run this tutorial.');
    await new Promise<void>((resolve, reject) => {
      const request = manager.request(`fiber-docs:node:${profileKey}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(new DuplicateNodeSessionError());
          return;
        }
        await new Promise<void>((done) => {
          release = async () => { done(); await request; };
          lockedProfile = profileKey;
          resolve();
        });
      });
      void request.catch(reject);
    });
  }

  async function stopNodeAndRelease() {
    // Do not relinquish ownership if shutdown fails: another runtime must not
    // open the same IndexedDB database while this one might still be running.
    await current?.stop();
    current = undefined;
    await release?.();
    release = undefined;
    lockedProfile = undefined;
  }

  return {
    start(profileKey: string, start: (track: (node: RunningNode) => void) => Promise<void>): Promise<void> {
      if (disposed) return Promise.reject(new Error('This tutorial has been closed. Reopen it to start the node.'));
      if (operation) return operation;
      const run = async () => {
        if (lockedProfile && lockedProfile !== profileKey) throw new Error('Stop the current node before selecting a different profile.');
        if (!release) await acquire(profileKey);
        if (disposed) return;
        try {
          await start((node) => {
            if (disposed) throw new Error('The tutorial was closed before the node started.');
            current = node;
          });
        } catch (error) {
          if (!current?.isRunning) await stopNodeAndRelease();
          throw error;
        }
      };
      operation = run().finally(() => { operation = undefined; });
      return operation;
    },
    stop(): Promise<void> {
      if (closing) return closing;
      disposed = true;
      closing = (async () => {
        try { await operation; } catch { /* Failed startup is already reported. */ }
        await stopNodeAndRelease();
      })();
      return closing;
    },
  };
}
