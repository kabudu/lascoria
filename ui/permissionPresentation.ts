import type { Json } from './types';
export const profileLabels: Record<string, string> = {
  ':ask-me': 'Ask me',
  ':auto-review': 'Auto-review',
  ':read-only': 'Read-only',
  ':unrestricted': 'Unrestricted',
};
export const modeLabels: Record<string, string> = {
  onRequest: 'Review risky shell commands',
  promptUnmatched: 'Review unmatched shell commands',
  denyUnmatched: 'Reject unmatched shell commands',
  allowAll: 'Skip approval requests',
};
export function permissionSummary(value: Json, current: boolean) {
  if (!current || !value?.current) return 'Permissions unknown';
  const profile =
    profileLabels[value.permissionState?.profileId] ??
    value.permissionState?.profileId ??
    'Custom access';
  const boundary = value.permissionState?.axes?.filesystem;
  const mode = value.approvalMode?.mode;
  return `${profile}${mode === 'allowAll' ? ' · No approval requests' : mode === 'promptUnmatched' ? ' · Strict shell review' : mode === 'denyUnmatched' ? ' · Rule-only shell' : ''} · ${boundary === 'sandboxed' ? (value.sandboxAvailability === 'available' ? 'Sandboxed' : value.sandboxAvailability === 'unavailable' ? 'Sandbox unavailable' : 'Sandbox unverified') : boundary === 'unrestricted' ? 'Sandbox off' : 'Boundary unknown'}`;
}
