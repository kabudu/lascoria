// Presentation/control adapter only. Muse owns policy admission and OS enforcement.
import { createHash, randomUUID } from 'node:crypto';
export class PermissionValidationError extends Error {}
export const SAFE_PROFILES = [':ask-me', ':auto-review', ':read-only'];
export const APPROVAL_MODES = ['onRequest', 'promptUnmatched', 'denyUnmatched', 'allowAll'];
export function initialProfile(value = ':ask-me') {
  if (!SAFE_PROFILES.includes(value))
    throw new PermissionValidationError('Choose Ask me, Auto-review or Read-only');
  return value;
}
export function permissionTracker(read, handshake) {
  const generation = randomUUID();
  let epoch = 0;
  let state = { current: false };
  let reading;
  function invalidate() {
    epoch++;
    state = { ...state, current: false };
  }
  async function refresh(sessionId) {
    if (reading) return reading;
    reading = (async () => {
      // Managed changes may race a read. Never label an older reply current.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = epoch;
        try {
          const value = await read('session/read', { sessionId, excludeItems: true });
          if (before !== epoch) continue;
          const session = value.session;
          const facts = {
            permissionState: session.permissionState ?? null,
            approvalMode: session.approvalMode ?? null,
            sandboxAvailability: handshake.sandboxAvailability ?? 'unknown',
            sandboxUnavailableReason: handshake.sandboxUnavailableReason,
            workspaceRoot: session.workspaceRoot,
          };
          state = {
            ...facts,
            observedAtMs: Date.now(),
            current: Boolean(
              facts.permissionState &&
              facts.approvalMode &&
              (typeof facts.permissionState.profileId === 'string' ||
                facts.permissionState.profileId === null) &&
              typeof facts.permissionState.reviewerAuthority === 'string' &&
              typeof facts.permissionState.reviewerAttached === 'boolean' &&
              typeof facts.approvalMode.mode === 'string',
            ),
            key: createHash('sha256')
              .update(JSON.stringify([generation, epoch, facts]))
              .digest('hex'),
          };
          return state;
        } catch {
          state = {
            current: false,
            error: 'Muse permission state could not be read. Refresh before changing access.',
          };
          return state;
        }
      }
      state = {
        current: false,
        error: 'Permissions changed while being read. Refresh before continuing.',
      };
      return state;
    })().finally(() => {
      reading = undefined;
    });
    return reading;
  }
  return {
    invalidate,
    refresh,
    get state() {
      return state;
    },
  };
}
export function checkPermissionChange(params, state) {
  if (params.confirmed !== true)
    throw new PermissionValidationError('Confirm this permission change first');
  if (!state.current || typeof params.expectedKey !== 'string' || params.expectedKey !== state.key)
    throw new PermissionValidationError(
      'Permissions changed or are unavailable. Refresh and review the change again',
    );
}
export function profileChoices(catalog) {
  if (!Array.isArray(catalog.profiles) || catalog.profiles.length > 100)
    throw new PermissionValidationError('Muse permission catalogue exceeds its bounds');
  return catalog.profiles.map((row) => ({
    ...row,
    selectable: row.available === true && SAFE_PROFILES.includes(row.profileId),
    ...(!SAFE_PROFILES.includes(row.profileId)
      ? {
          limitation:
            'Custom and unrestricted access are not selectable in Lascoria. Review custom policy using Muse’s native controls after safely closing the affected host.',
        }
      : {}),
  }));
}
