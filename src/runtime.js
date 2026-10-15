import { spawnMspConnection, readSessionDurability, Session, MspError } from '@muse-code/sdk';

export async function bounded(promise, ms = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Operation timed out; outcome unknown')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function spawnRuntime(options, onEvent, onDeath) {
  const handshake = spawnMspConnection({
    command: options.binary ?? process.env.MUSE_BIN ?? 'muse',
    args: ['serve', '--provider', options.provider ?? 'echo', ...(options.args ?? [])],
    env: options.env,
    shutdownTimeoutMs: 2000,
  });
  let host;
  try {
    host = await bounded(
      handshake.initialize({
        clientInfo: { name: 'spatial_constellation', version: '0.1.0' },
        capabilities: { requestedCapabilities: options.capabilities ?? [] },
      }),
    );
    if (host.fingerprintWarning)
      throw new Error(`SDK schema mismatch: ${JSON.stringify(host.fingerprintWarning)}`);
    if (host.initializeResult.serverInfo.version !== '1.4.9')
      throw new Error('Unsupported Muse binary version; this spike is validated against 1.4.9');
  } catch (error) {
    await handshake.close();
    throw error;
  }
  async function read(method, params) {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await bounded(host.connection.request(method, params));
        if (method === 'view/page') for (const event of result.events) options.onHistory?.(event);
        return result;
      } catch (error) {
        if (
          method !== 'view/page' ||
          attempt >= 4 ||
          !(error instanceof MspError) ||
          !['overloaded', 'backpressured'].includes(error.kind) ||
          error.retryable === false
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  }
  const profile = readSessionDurability(host.initializeResult);
  let session;
  let gapFailure;
  let gapBudget = { pages: 0, events: 0, bytes: 0 };
  const foldConnection = new Proxy(host.connection, {
    get(target, key) {
      if (key === 'request')
        return async (method, params) => {
          const result = await read(method, params);
          if (method === 'view/page') {
            gapBudget.pages++;
            gapBudget.events += result.events.length;
            gapBudget.bytes += Buffer.byteLength(JSON.stringify(result));
            if (
              gapBudget.pages > 100 ||
              gapBudget.events > 10000 ||
              gapBudget.bytes > 32 * 1024 * 1024
            )
              throw new Error('SDK gap fill exceeds diagnostic bounds');
          }
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let closing = false;
  host.connection.onNotification((event) => {
    try {
      if (event.params?.sessionId) onEvent(event);
    } catch (error) {
      onDeath({ kind: 'projectionFailure', message: error.message });
      void close();
    }
  });
  host.connection.onServerRequest(async (request) => {
    if (!['approval/request', 'userInput/request'].includes(request.method))
      throw new Error(`Unsupported server request: ${request.method}`);
    return {}; // Acknowledge handling only. Decisions are separate journaled commands.
  });
  host.connection.onProtocolError((error) => {
    onDeath({ kind: 'protocolError', message: error.message });
    void close();
  });
  let reported = false;
  const died = (exit) => {
    if (!closing && !reported) {
      reported = true;
      onDeath(exit);
    }
  };
  host.child.exit.then(died);
  host.connection.closed.then(async () => {
    try {
      died(await bounded(host.child.exit, 500));
    } catch {
      died({ kind: 'transportEof' });
    }
  });
  async function close() {
    closing = true;
    await host.close();
  }
  return {
    handshake: host.initializeResult,
    profile,
    command: (method, params, id) =>
      bounded(host.connection.command(method, params, { commandId: id, maxAttempts: 1 })),
    request: read,
    beginGap() {
      gapBudget = { pages: 0, events: 0, bytes: 0 };
    },
    attach(id, events) {
      session = new Session({ sessionId: id, durability: profile, connection: foldConnection });
      gapFailure = undefined;
      session.onGapError((error) => {
        gapFailure = error.message + (error.cause ? `: ${error.cause.message}` : '');
        console.error(gapFailure);
      });
      for (const event of events) session.apply(event);
      return session;
    },
    get gapFailure() {
      return gapFailure;
    },
    get session() {
      return session;
    },
    close,
    isRejection: (error) => error instanceof MspError,
  };
}
