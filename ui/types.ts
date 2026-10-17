export type Json = any;
export type Item = import('@muse-code/sdk/dist/src/msp.js').Item & {
  sourceSessionId?: string;
  [key: string]: Json;
};
export interface SessionRow {
  projectContextReceipt?: {
    requestId: string;
    status: string;
    commandId?: string;
    appliedWith?: 'turn';
  };
  /** A next-task folder change awaiting its native receipt, or whose outcome is unknown. */
  projectContextPending?: { revision: number; requestId: string; status: string };
  projectContext?: {
    id: string;
    name: string;
    revision: number;
    folders: { id: string; name: string; path: string }[];
  };
  displayName?: string;
  nameRevision?: number;
  id: string;
  workspace: string;
  workspaceDiscarded?: boolean;
  managedWorkspace?: { source: string; path: string; branch: string; base: string };
  generation: number;
  lifecycle: string;
  durability?: string;
  continuedFrom?: string;
  recoveryError?: string;
  interruptions: Json[];
  state: {
    current: boolean;
    activeTurnId?: string;
    items: Item[];
    totalItems: number;
    turns: Json[];
    approvals: Json[];
    userInputs: Json[];
    gaps?: Json[];
    [key: string]: Json;
  };
  handshake?: Json;
}
export type StatusReply = Status | { unchanged: true; version: string; pid: number };
export interface Status {
  relayConnections?: { sessions: string[]; allowAgentMessages: boolean }[];
  relayUnread?: { sessionId: string; peerId: string; count: number }[];
  version?: string;
  features?: string[];
  pid: number;
  sessions: SessionRow[];
  commands: Json[];
}
export interface Task {
  id: string;
  sessionId: string;
  turnId?: string | null;
  item?: Item;
  label: string;
  status: string;
  provenance: 'derived' | 'native';
  parentId?: string;
  childSessionId?: string;
  nativeChild?: Json;
  error?: { kind: string; message: string; retryable?: boolean };
}
export interface Prefs {
  canvasControlsCollapsed?: boolean;
  zoom?: number;
  canvasOffset?: { x: number; y: number };
  panels?: Record<string, { x: number; y: number; collapsed: boolean }>;
  selection?: string;
  selections?: Record<string, string>;
  sessionId?: string;
  sessionLabels?: Record<string, string>;
  view?: 'map' | 'list';
  theme?: 'dark' | 'light';
  search?: string;
  showRuntimeReminders?: boolean;
  /** Saved choice from the Log out dialog, applied when the window closes or the app quits. */
  closeBehavior?: 'keepRunning' | 'pause';
  collapsed?: string[];
  acknowledgedInterruptions?: string[];
  acknowledgedTaskFacts?: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  positions?: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number };
  edges?: {
    id: string;
    from: string;
    to: string;
    kind: string;
    provenance: 'userAsserted';
    revision: number;
  }[];
}
export interface Artifact {
  id: string;
  sessionId: string;
  taskId: string;
  fingerprint: string;
  base: string;
  head: string;
  patch: string;
  untracked: { path: string; text?: string; bytes: number; sha256: string }[];
  capturedAtMillis: number;
  provenance: string;
}
export interface Evidence {
  id: string;
  artifactId: string;
  fingerprint: string;
  params: Json;
  provenance: string;
  recordedAtMillis: number;
  source: Item;
}
