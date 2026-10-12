export type Json = any;
export type Item = import('@muse-code/sdk/dist/src/msp.js').Item & {
  sourceSessionId?: string;
  [key: string]: Json;
};
export interface SessionRow {
  id: string;
  workspace: string;
  generation: number;
  lifecycle: string;
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
export interface Status {
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
}
export interface Prefs {
  selection?: string;
  selections?: Record<string, string>;
  sessionId?: string;
  view?: 'map' | 'list';
  theme?: 'dark' | 'light';
  search?: string;
  collapsed?: string[];
  acknowledgedInterruptions?: string[];
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
