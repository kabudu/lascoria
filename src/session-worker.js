// Private SDK bridge. Only the Rust supervisor owns the public control API.
import { Session } from '@muse-code/sdk';
import { isDeepStrictEqual } from 'node:util';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { toNamespacedPath } from 'node:path';
import { bounded, spawnRuntime } from './runtime.js';

export async function createSession(send, onDeath) {
  let ended = false;
  let closePromise;
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const turnId = runtime?.session?.fold.activeTurnId;
      if (!ended && turnId) {
        shutdown = { kind: 'gracefulStop', turnId, cancellation: 'unconfirmed' };
        try {
          if (stale || !runtime.session.fold.current) throw new Error('Projection unavailable');
          await bounded(runtime.command('turn/cancel', { sessionId, turnId }), 3000);
          const deadline = Date.now() + 1500;
          while (runtime.session.fold.activeTurnId === turnId && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 25));
          if (!runtime.session.fold.activeTurnId)
            shutdown.cancellation =
              runtime.session.fold.turns().find((turn) => turn.turnId === turnId)?.terminal ===
              'cancelled'
                ? 'confirmed'
                : 'alreadySettled';
        } catch {
          // An unavailable host cannot establish a new checkpoint. Preserve the
          // last durable projection; never replay an uncertain model/tool call.
        }
      }
      if (!ended && runtime?.session && sessionId) publishState([], true);
      ended = true;
      clearTimeout(stateTimer);
      await runtime?.close();
    })();
    return closePromise;
  }
  async function fail(exit) {
    if (ended) return;
    ended = true;
    clearTimeout(stateTimer);
    onDeath(exit);
    await close();
  }
  class ValidationError extends Error {}
  let sessionId;
  let eventCount = 0;
  let eventBytes = 0;
  let stale = false;
  let closing = false;
  let opening = false;
  let acceptedReceipt;
  let staleReason;
  let runtime;
  let shutdown;
  let modelRoute;
  let skillsRevision = 0;
  const diagnostics = { snapshots: 0, snapshotTotalMs: 0, snapshotMaxMs: 0 };
  const gaps = [];
  const itemProvenance = new Map();
  // T1: per-task and per-model token use from Muse's session/tokenUsage events, seen live or
  // in recovered history. Each completion is counted once (by view cursor). Muse's own
  // cumulative session total stays authoritative; these breakdowns cover what this host saw.
  const tokenCursors = new Set();
  const tokensByTurn = new Map();
  const tokensByModel = new Map();
  function addTokens(map, key, usage, limit) {
    const entry = map.get(key) ?? {
      calls: 0,
      promptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
    };
    entry.calls++;
    entry.promptTokens += usage.promptTokens;
    entry.outputTokens += usage.usage?.outputTokens ?? 0;
    entry.totalTokens += usage.totalTokens;
    entry.reasoningTokens += usage.usage?.reasoningTokens ?? 0;
    entry.cacheReadTokens += usage.usage?.cacheReadTokens ?? 0;
    map.delete(key);
    map.set(key, entry);
    if (map.size > limit) map.delete(map.keys().next().value);
  }
  function countTokens(params) {
    if (
      !params?.viewCursor ||
      tokenCursors.has(params.viewCursor) ||
      !Number.isFinite(params.promptTokens) ||
      !Number.isFinite(params.totalTokens)
    )
      return;
    tokenCursors.add(params.viewCursor);
    if (tokenCursors.size > 20000) tokenCursors.delete(tokenCursors.values().next().value);
    if (typeof params.turnId === 'string') addTokens(tokensByTurn, params.turnId, params, 100);
    addTokens(tokensByModel, String(params.modelId ?? 'unknown'), params, 20);
  }
  function rememberSource(event) {
    if (event.params?.sessionId !== sessionId) return;
    if (event.method === 'session/tokenUsage') countTokens(event.params);
    const item = event.params?.item;
    if (item && event.params.viewCursor && event.params.sourceRange) {
      const previous = itemProvenance.get(item.itemId);
      if (!previous || previous.revision <= item.revision)
        itemProvenance.set(item.itemId, {
          revision: item.revision,
          viewCursor: event.params.viewCursor,
          sourceRange: event.params.sourceRange,
          method: event.method,
        });
      if (itemProvenance.size > 10000) throw new Error('Item provenance budget exhausted');
    }
  }

  let gapRecovery;
  let stateTimer;
  const stateFacts = new Map();
  function publishState(facts = [], immediate = false) {
    for (const fact of facts) {
      if (!fact.commandId) continue;
      stateFacts.set(fact.commandId + fact.method, fact);
      if (stateFacts.size > 2000) {
        void fail({ kind: 'stateBudgetExceeded' });
        return;
      }
    }
    if (ended) return;
    if (immediate) {
      clearTimeout(stateTimer);
      stateTimer = undefined;
      send({ kind: 'state', state: snapshot(), facts: [...stateFacts.values()] });
      stateFacts.clear();
    } else if (!stateTimer) stateTimer = setTimeout(() => publishState([], true), 25);
  }
  const commandFact = (event) => ({
    method: event.method,
    commandId: event.params.commandId ?? event.params.decidedByCommandId,
  });
  function snapshot() {
    const start = performance.now();
    const value = buildSnapshot();
    const elapsed = performance.now() - start;
    diagnostics.snapshots++;
    diagnostics.snapshotTotalMs += elapsed;
    diagnostics.snapshotMaxMs = Math.max(diagnostics.snapshotMaxMs, elapsed);
    return {
      ...value,
      modelRoute: (() => {
        const route = runtime?.session?.fold.sessionState.get('session/modelChanged');
        return route ? { providerId: route.providerId, modelId: route.modelId } : modelRoute;
      })(),
      reasoningEffort: runtime?.session?.fold.sessionState.get('session/reasoningEffortChanged')
        ?.reasoningEffort,
      skillsRevision,
      tokens: {
        byTurn: Object.fromEntries(tokensByTurn),
        byModel: Object.fromEntries(tokensByModel),
      },
      diagnostics: {
        ...diagnostics,
        rssBytes: process.memoryUsage.rss(),
        rssScope: 'sdkProcess',
        processId: process.pid,
      },
    };
  }
  function buildSnapshot() {
    const fold = runtime?.session?.fold;
    // Cold replay and live gap repair may discover items in different insertion orders.
    // Keep content, provenance and provisional text in the same presentation window.
    const items = (fold?.items.list() ?? [])
      .sort(
        (a, b) =>
          (a.recordedAt ?? '').localeCompare(b.recordedAt ?? '') ||
          a.itemId.localeCompare(b.itemId),
      )
      .slice(-100);
    return {
      sessionId,
      ...(shutdown ? { shutdown } : {}),
      itemProvenance: Object.fromEntries(
        items
          .map((item) => [item.itemId, itemProvenance.get(item.itemId)])
          .filter(([id, value]) => value?.revision === fold.items.get(id)?.revision),
      ),
      current: !stale && !opening && !!fold?.current,
      relayToolsAvailable: Boolean(
        process.env.SCH_RELAY_HELPER &&
        runtime?.handshake.grantedCapabilities?.includes('sessionMcp'),
      ),
      sessionState: Object.fromEntries(
        (fold?.sessionState.families() ?? []).map((family) => [
          family,
          fold.sessionState.get(family),
        ]),
      ),
      turns: fold?.turns().slice(-100) ?? [],
      gap: fold?.pendingGap,
      gaps,
      failure: staleReason,
      activeTurnId: fold?.activeTurnId,
      items,
      provisionalText: Object.fromEntries(
        items
          .filter((item) => item.status === 'inProgress')
          .map((item) => [item.itemId, fold.items.accumulated(item.itemId, 'text')])
          .filter(([, value]) => value !== undefined),
      ),
      totalItems: fold?.items.size ?? 0,
      itemsTruncated: (fold?.items.size ?? 0) > 100,
      approvals: fold?.pendingApprovals() ?? [],
      userInputs: fold?.pendingUserInputs() ?? [],
      eventCount,
      eventBytes,
    };
  }
  try {
    runtime = await spawnRuntime(
      {
        binary: process.env.MUSE_BIN,
        provider: process.env.SCH_PROVIDER ?? 'echo',
        onHistory: rememberSource,
        capabilities: process.env.SCH_RELAY_HELPER ? ['sessionMcp'] : [],
        onUsage: (usage) => {
          if (!ended && usage && typeof usage === 'object') send({ kind: 'usage', usage });
        },
      },
      (event) => {
        if (ended || event.params?.sessionId !== sessionId) return;
        rememberSource(event);
        eventCount++;
        eventBytes += Buffer.byteLength(JSON.stringify(event));
        if (eventCount > 10000 || eventBytes > 32 * 1024 * 1024) {
          stale = true;
          staleReason = 'Diagnostic event budget exhausted';
        }
        // Advisory: the session's invocable skills changed, so cached catalogs are stale.
        if (event.method === 'skill/changed') skillsRevision++;
        if (event.method === 'view/gap' && !gapRecovery) runtime.beginGap();
        const applied = !stale ? runtime.session.apply(event) : undefined;
        if (event.method === 'view/gap' && !stale) {
          gaps.push({
            ...event.params,
            observedAtMillis: Date.now(),
            recovered: false,
            unavailableDuringFill: !runtime.session.fold.current,
          });
          if (gaps.length > 20) gaps.shift();
          if (!gapRecovery) {
            gapRecovery = bounded(applied.io, 60000)
              .then(() => {
                if (!runtime.session.fold.current) {
                  stale = true;
                  staleReason = runtime.gapFailure ?? 'Muse stream gap could not be filled';
                  publishState([], true);
                  return fail({ kind: 'projectionUnavailable', message: staleReason });
                }
                for (const gap of gaps)
                  if (!gap.recovered) {
                    gap.recovered = true;
                    gap.recoveredAtMillis = Date.now();
                  }
                publishState([], true);
              })
              .catch((error) => {
                stale = true;
                staleReason = error.message;
                publishState([], true);
                return fail({ kind: 'projectionUnavailable', message: staleReason });
              })
              .finally(() => {
                gapRecovery = undefined;
              });
          }
        }
        publishState([commandFact(event)], event.method === 'view/gap' || stale);
        if (stale) void fail({ kind: 'projectionUnavailable', message: staleReason });
      },
      (exit) => {
        if (!closing) void fail(exit);
      },
    );
    if (ended) throw new Error('Muse died during initialization');
  } catch (error) {
    await close();
    throw error;
  }

  async function execute(message) {
    const { operation, params, commandId } = message;
    if (['models', 'usage', 'skills'].includes(operation)) {
      if (ended || !runtime.session?.fold.current || params.sessionId !== sessionId)
        throw new ValidationError('Session state unavailable');
      return operation === 'usage'
        ? runtime.request('usage/read', {})
        : runtime.request(operation === 'skills' ? 'skill/list' : 'model/list', { sessionId });
    }
    if (operation === 'readOutput') {
      if (stale || !runtime.session?.fold.current || params.sessionId !== sessionId)
        throw new ValidationError('Session state unavailable');
      const item = runtime.session.fold.items.get(params.itemId);
      if (
        !item ||
        item.revision !== params.revision ||
        ![item.outputRef?.id, item.patchRef?.id].includes(params.outputRef) ||
        !params.outputRef
      )
        throw new ValidationError('Stale or unknown output reference');
      if (
        !Number.isInteger(params.offsetBytes ?? 0) ||
        (params.offsetBytes ?? 0) < 0 ||
        (params.offsetBytes ?? 0) > 256 * 1024 * 1024
      )
        throw new ValidationError('Output offset exceeds bounds');
      return runtime.request('item/readOutput', {
        sessionId,
        itemId: item.itemId,
        outputRef: params.outputRef,
        offsetBytes: params.offsetBytes ?? 0,
        lengthBytes: 65536,
      });
    }
    if (operation === 'inspect') {
      if (stale || !runtime.session?.fold.current || params.sessionId !== sessionId)
        throw new ValidationError('Session state unavailable');
      let fold = runtime.session.fold;
      if (params.childSessionId) {
        if (!fold.items.list().some((item) => item.childSessionId === params.childSessionId))
          throw new ValidationError('Unknown native child session');
        const child = new Session({
          sessionId: params.childSessionId,
          durability: runtime.profile,
        });
        let cursor;
        let bytes = 0;
        let count = 0;
        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
          const page = await runtime.request('view/page', {
            sessionId: params.childSessionId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          for (const event of page.events) {
            count++;
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (count > 10000 || bytes > 32 * 1024 * 1024)
              throw new ValidationError('Child history exceeds bounds');
            child.apply(event);
          }
          if (page.nextCursor === null) break;
          cursor = page.events.at(-1)?.params.viewCursor;
          if (!cursor || pageNumber === 99)
            throw new ValidationError('Child paging did not converge');
        }
        fold = child.fold;
      }
      const offset = params.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
        throw new ValidationError('Invalid transcript offset');
      const items = fold.items
        .list()
        .sort(
          (a, b) =>
            (a.recordedAt ?? '').localeCompare(b.recordedAt ?? '') ||
            a.itemId.localeCompare(b.itemId),
        );
      return {
        items: items.slice(offset, offset + 100),
        totalItems: items.length,
        nextOffset: offset + 100 < items.length ? offset + 100 : null,
        current: fold.current,
      };
    }
    if (operation === 'stop') {
      await close();
      return {};
    }
    if (operation === 'start' || operation === 'resume') {
      if (operation === 'resume' && runtime.profile.kind !== 'durable')
        throw new ValidationError('Recovery unsupported for this durability');
      opening = true;
      sessionId = params.sessionId;
      runtime.attach(sessionId, []);
      let initialRoute = {};
      if (
        operation === 'start' &&
        params.modelId &&
        (process.env.SCH_PROVIDER ?? 'echo') === 'echo'
      )
        throw new ValidationError('Explicit model selection is unavailable for the echo provider');
      if (operation === 'start' && (process.env.SCH_PROVIDER ?? 'echo') !== 'echo') {
        const catalog = await runtime.request('model/list', {});
        const defaults = catalog.models.filter((model) => model.isDefault);
        if ((!params.modelId && defaults.length !== 1) || !catalog.providerId)
          throw new ValidationError(
            'Muse must advertise one default model before starting a live session',
          );
        initialRoute = {
          providerId: catalog.providerId,
          modelId: params.modelId ?? defaults[0].modelId,
        };
      }
      const relayConfig =
        process.env.SCH_RELAY_HELPER &&
        runtime.handshake.grantedCapabilities?.includes('sessionMcp')
          ? {
              config: {
                mcpServers: {
                  lascoria_local: {
                    transport: 'stdio',
                    command: process.env.SCH_RELAY_HELPER,
                    args: ['--relay-mcp', sessionId],
                    env: {
                      SCH_STATE_DIR: process.env.SCH_RELAY_STATE_DIR,
                      // F1: binds this helper to this session's host; never logged or shown.
                      ...(/^[0-9a-f]{64}$/.test(params.relayCapability ?? '')
                        ? { SCH_RELAY_CAPABILITY: params.relayCapability }
                        : {}),
                    },
                    framing: 'lineDelimitedJson',
                    mode: 'required',
                  },
                },
              },
            }
          : {};
      const result = await runtime.command(
        operation === 'start' ? 'session/start' : 'session/resume',
        operation === 'start'
          ? {
              sessionId,
              workspaceRoot: params.workspace,
              // Muse requires native canonical roots, including the Windows namespace prefix.
              ...(params.workspaceRoots
                ? { workspaceRoots: params.workspaceRoots.map(toNamespacedPath) }
                : {}),
              ...initialRoute,
              ...relayConfig,
            }
          : { sessionId, excludeItems: true, ...relayConfig },
        commandId,
      );
      modelRoute = { providerId: result.session.providerId, modelId: result.session.modelId };
      acceptedReceipt = result;
      if (operation === 'resume') {
        await runtime.request('view/unsubscribe', { sessionId });
        const events = [];
        let cursor;
        let bytes = 0;
        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
          const page = await runtime.request('view/page', {
            sessionId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          for (const event of page.events) {
            events.push(event);
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (events.length > 10000 || bytes > 32 * 1024 * 1024)
              throw new ValidationError('Recovery history exceeds diagnostic bounds');
          }
          const last = page.events.at(-1)?.params.viewCursor;
          if (last) cursor = last;
          if (page.nextCursor === null) break;
          if (!last || pageNumber === 99)
            throw new ValidationError('Recovery paging did not converge');
        }
        itemProvenance.clear();
        for (const event of events) rememberSource(event);
        runtime.attach(sessionId, events);
        eventCount = events.length;
        eventBytes = bytes;
        stale = false;
        await runtime.request('view/subscribe', {
          sessionId,
          ...(cursor ? { after: cursor } : {}),
        });
        if (!runtime.session.fold.current)
          throw new ValidationError('Recovery did not produce current state');
        opening = false;
        publishState(events.map(commandFact), true);
      }
      opening = false;
      publishState([], true);
      return result;
    }
    if (stale || !runtime.session?.fold.current || sessionId !== params.sessionId)
      throw new ValidationError('Session state is not current');
    if (operation === 'mediaUpload') return uploadChunk(params);
    let method;
    let wire;
    if (operation === 'turn' || operation === 'steer') {
      if (typeof params.text !== 'string' || !params.text.length || params.text.length > 16000)
        throw new ValidationError('Text must be 1..16000 characters');
      method = operation === 'turn' ? 'turn/start' : 'turn/steer';
      let input = [{ type: 'text', text: params.text }];
      const shortcut = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(params.text);
      if (shortcut?.[1] === 'usage')
        throw new ValidationError('/usage is a local read-only command');
      if (shortcut) {
        const catalog = await runtime.request('skill/list', { sessionId });
        if (!catalog.skills.some((skill) => skill.selector === shortcut[1]))
          throw new ValidationError(
            'Muse skill is no longer available; reopen the shortcuts picker',
          );
        input = [{ type: 'skill', selector: shortcut[1], arguments: shortcut[2] ?? '' }];
      }
      wire = { sessionId, input };
      if (params.images !== undefined) {
        // Verified private files staged by the supervisor; bytes are read only now, on send.
        if (operation !== 'turn' || !Array.isArray(params.images) || params.images.length > 4)
          throw new ValidationError('Images can be added to a new task only');
        if (input[0].type !== 'text')
          throw new ValidationError('Add images to a plain task, not a shortcut');
        for (const image of params.images) {
          const bytes = await readFile(image.path);
          if (createHash('sha256').update(bytes).digest('hex') !== image.sha256)
            throw new ValidationError('An attached image changed after it was checked');
          input.push({
            type: 'image',
            mediaType: image.mediaType,
            base64Data: bytes.toString('base64'),
            width: image.width,
            height: image.height,
          });
        }
      }
      if (params.videos !== undefined) {
        // Already in Muse's session store through media/upload; the part names the receipt.
        if (operation !== 'turn' || !Array.isArray(params.videos) || params.videos.length > 1)
          throw new ValidationError('A video can be added to a new task only');
        if (input[0].type !== 'text')
          throw new ValidationError('Add a video to a plain task, not a shortcut');
        for (const video of params.videos) input.push({ type: 'video', uploadId: video.uploadId });
      }
      if (params.files !== undefined) {
        // Text files become clearly delimited text after the task; the transcript keeps the
        // user's own words and names the files.
        if (operation !== 'turn' || !Array.isArray(params.files) || params.files.length > 4)
          throw new ValidationError('Files can be added to a new task only');
        if (input[0].type !== 'text')
          throw new ValidationError('Add files to a plain task, not a shortcut');
        for (const file of params.files) {
          const bytes = await readFile(file.path);
          if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
            throw new ValidationError('An attached file changed after it was checked');
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
          const name = String(file.name).replace(/[\r\n"]/g, ' ');
          input.push({
            type: 'text',
            text: `\n\n<attached_file name="${name}" bytes="${bytes.length}">\n${text}\n</attached_file>`,
          });
        }
        wire.displayText = `${params.text}\n\nAttached: ${params.files.map((f) => f.name).join(', ')}`;
      }
      if (params.workspaceRoots !== undefined) {
        // Sticky native replacement, bound at this turn's launch (turn/start.workspaceRoots).
        // The supervisor validated the saved Project; refuse anything that is not an idle new task.
        if (
          operation !== 'turn' ||
          !Array.isArray(params.workspaceRoots) ||
          params.workspaceRoots.length < 1 ||
          params.workspaceRoots.length > 8 ||
          !params.workspaceRoots.every((root) => typeof root === 'string' && root.length <= 4096)
        )
          throw new ValidationError('Invalid workspace roots');
        if (runtime.session.fold.activeTurnId)
          throw new ValidationError(
            'Finish or stop the current task before applying Project folder changes',
          );
        wire.workspaceRoots = params.workspaceRoots.map(toNamespacedPath);
      }
      // Model-visible Project context the supervisor attached: a folder change (Muse 1.4.10
      // applies the replacement but keeps describing the session-start folders) or the Project
      // goal and notes with the first task. The transcript keeps the user's own words.
      if (typeof params.projectNote === 'string' && params.projectNote.length <= 8192) {
        if (operation !== 'turn') throw new ValidationError('Project notes travel with a new task');
        if (input[0].type !== 'text')
          throw new ValidationError(
            'Apply Project folder changes with a plain task, then use the shortcut',
          );
        wire.input = [{ type: 'text', text: params.projectNote }, ...input];
        wire.displayText ??= params.text;
      }
      if (operation === 'steer') {
        if (!params.turnId || runtime.session.fold.activeTurnId !== params.turnId)
          throw new ValidationError('Stale steering target');
        wire.expectedTurnId = params.turnId;
      }
    } else if (operation === 'setModel') {
      const catalog = await runtime.request('model/list', { sessionId });
      const model = catalog.models.find((m) => m.modelId === params.modelId);
      if (!model) throw new ValidationError('Model is not in this session catalog');
      method = 'session/setModel';
      wire = {
        sessionId,
        model: {
          modelId: model.modelId,
          providerId: catalog.providerId,
          ...(catalog.profileId ? { profileId: catalog.profileId } : {}),
        },
      };
    } else if (operation === 'setEffort') {
      const catalog = await runtime.request('model/list', { sessionId });
      const route = runtime.session.fold.sessionState.get('session/modelChanged') ?? modelRoute;
      const model = catalog.models.find((m) => m.modelId === route?.modelId);
      if (!model?.variants?.includes(params.reasoningEffort))
        throw new ValidationError('Effort is not advertised for the selected model');
      method = 'session/setReasoningEffort';
      wire = { sessionId, reasoningEffort: params.reasoningEffort };
    } else if (operation === 'compact') {
      // T4: user-requested native compaction. Muse summarises older history itself; Lascoria
      // never rewrites the transcript. Only between tasks, so a running task is not disturbed.
      if (runtime.session.fold.activeTurnId)
        throw new ValidationError('Wait for the current task to finish before compacting');
      method = 'session/compact';
      wire = { sessionId };
    } else if (operation === 'cancel') {
      if (!params.turnId || runtime.session.fold.activeTurnId !== params.turnId)
        throw new ValidationError('Stale cancellation target');
      method = 'turn/cancel';
      wire = { sessionId, turnId: params.turnId };
    } else if (operation === 'decide') {
      const pending = await runtime.request('approval/listPending', { sessionId });
      const approval = pending.approvals.find((a) => a.approvalId === params.approvalId);
      if (!approval || !isDeepStrictEqual(approval.currentRequirementId, params.requirementId))
        throw new ValidationError('Stale approval; refresh status');
      if (!approval.availableChoices.some((choice) => choice.choiceId === params.choiceId))
        throw new ValidationError('Choice not offered by Muse');
      method = 'approval/decide';
      wire = {
        sessionId,
        approvalId: params.approvalId,
        requirementId: params.requirementId,
        choiceId: params.choiceId,
      };
    } else if (operation === 'answer') {
      const pending = await runtime.request('approval/listPending', { sessionId });
      if (!pending.userInputs.some((input) => input.userInputId === params.userInputId))
        throw new ValidationError('Stale user input');
      method = 'userInput/answer';
      wire = { sessionId, userInputId: params.userInputId, answers: params.answers };
    } else throw new ValidationError('Unsupported operation');
    return runtime.command(method, wire, commandId);
  }

  /**
   * One `media/upload` chunk of a staged video, read from the verified private file. The
   * command identity is derived from the upload receipt and chunk position, so a resent task
   * replays chunks Muse already recorded instead of storing them twice.
   */
  async function uploadChunk(params) {
    const { path, uploadId, chunkIndex, chunkCount, chunkBytes, bytes, mediaType } = params;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uploadId) ||
      !['video/mp4', 'video/quicktime'].includes(mediaType) ||
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(chunkCount) ||
      chunkIndex < 0 ||
      chunkIndex >= chunkCount ||
      chunkCount > 64 ||
      !Number.isInteger(chunkBytes) ||
      chunkBytes > 4 * 1024 * 1024 ||
      !Number.isInteger(bytes) ||
      Math.ceil(bytes / chunkBytes) !== chunkCount
    )
      throw new ValidationError('Invalid video upload');
    const file = await open(path, 'r');
    let chunk;
    try {
      if (chunkIndex === 0) {
        // Check the whole file once, streaming, before Muse stores any of it.
        const hash = createHash('sha256');
        let total = 0;
        for await (const piece of file.createReadStream({ autoClose: false, start: 0 })) {
          hash.update(piece);
          total += piece.length;
        }
        if (total !== bytes || hash.digest('hex') !== params.sha256)
          throw new ValidationError('The attached video changed after it was checked');
      }
      const length = Math.min(chunkBytes, bytes - chunkIndex * chunkBytes);
      chunk = Buffer.alloc(length);
      const { bytesRead } = await file.read(chunk, 0, length, chunkIndex * chunkBytes);
      if (bytesRead !== length) throw new ValidationError('The attached video is incomplete');
    } finally {
      await file.close();
    }
    const digest = createHash('sha256').update(`${uploadId}:${chunkIndex}`).digest('hex');
    const commandId = `${uploadId.slice(0, 19)}${((parseInt(digest[0], 16) & 3) | 8).toString(16)}${digest.slice(1, 4)}-${digest.slice(4, 16)}`;
    return runtime.command(
      'media/upload',
      {
        sessionId,
        uploadId,
        chunkIndex,
        chunkCount,
        totalBytes: bytes,
        mediaType,
        chunkBase64: chunk.toString('base64'),
      },
      commandId,
    );
  }

  let busy = false;
  return {
    ready: { kind: 'ready', handshake: runtime.handshake, durability: runtime.profile.kind },
    close,
    async handle(message) {
      if (ended || busy) throw new Error('Session worker unavailable or busy');
      busy = true;
      try {
        acceptedReceipt = undefined;
        const result = await execute(message);
        publishState([], true);
        return { kind: 'response', id: message.id, result };
      } catch (error) {
        return {
          kind: 'response',
          id: message.id,
          error: {
            message: error.message,
            rejected:
              !acceptedReceipt && (runtime.isRejection(error) || error instanceof ValidationError),
            receipt: acceptedReceipt,
            kind: error.kind,
            code: error.code,
          },
        };
      } finally {
        busy = false;
      }
    },
  };
}
