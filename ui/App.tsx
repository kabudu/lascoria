import { ProjectStart } from './ProjectStart';
import { FolderPath } from './FolderPath';
import { Help } from './Help';
import { DataLifecycle } from './DataLifecycle';
import { ExitDialog, type ExitChoice } from './ExitDialog';
import { HistorySearch } from './HistorySearch';
import { ProjectUpdate } from './ProjectUpdate';
import { ComposerImages } from './ComposerImages';
import { DraftConflict } from './DraftConflict';
import { useDurableDrafts, relayDraftStore } from './useDurableDrafts';
import { SkillPicker } from './SkillPicker';
import { Usage } from './Usage';
import { Account } from './Account';
import type { AccountStatus } from './Account';
import { Workspace } from './Workspace';
import { SessionRelay } from './SessionRelay';
import { SessionConnections } from './SessionConnections';
import { RenameSession } from './RenameSession';
import { SessionSettings } from './SessionSettings';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { recordTiming, timingSnapshot } from './diagnostics';
import { useCanvasGestures } from './useCanvasGestures';
import { FloatingPanel } from './FloatingPanel';
import type { PanelLayout } from './FloatingPanel';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FormEvent } from 'react';
import { connect, request } from './api';
import {
  tasks,
  nodeActivity,
  attention,
  questionAnswers,
  taskAttentionKey,
  constellationLayout,
  fitConstellation,
  freeCanvasFrame,
  zoomAtPoint,
} from './model';
import type {
  Status,
  StatusReply,
  SessionRow,
  Task,
  Prefs,
  Artifact,
  Evidence,
  Item,
  Json,
} from './types';
const empty: Status = { pid: 0, sessions: [], commands: [] };
const text = (value: Json) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const short = (value: string) => value.slice(-8);
function workflowSummary(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
export function App() {
  const [status, setStatus] = useState<Status>(empty),
    [prefs, setPrefs] = useState<Prefs>({
      theme: 'light',
      view: 'map',
      canvasControlsCollapsed: true,
    });
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const inspectorTabs = status.features?.includes('taskWorkspaces')
    ? ['transcript', 'diff', 'evidence', 'workspace']
    : ['transcript', 'diff', 'evidence'];
  const [runtimeReady, setRuntimeReady] = useState(!(window as any).__TAURI_INTERNALS__?.metadata);
  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__?.metadata) return;
    void invoke<{ ready: boolean }>('runtime_status')
      .then((value) => {
        setRuntimeReady(value.ready);
        if (!value.ready) setModal('account');
      })
      .catch(() => {
        setRuntimeReady(false);
        setModal('account');
      });
  }, []);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  // Last weekly allowance read when the menu opened; never polled in the background.
  const [menuUsage, setMenuUsage] = useState<{
    sessionId: string;
    weeklyRemaining: number;
    observedAtMs: number;
    readAtMs: number;
  } | null>(null);
  const accountOnboarded = useRef(false);
  const accountRequest = useRef(0);
  const accountAccepted = useRef(0);
  async function refreshAccount() {
    const order = ++accountRequest.current;
    try {
      const next = await request<AccountStatus>('account/status');
      if (order < accountAccepted.current) return;
      accountAccepted.current = order;
      setAccount(next);
      if (next.managed && !next.authenticated && !accountOnboarded.current) {
        accountOnboarded.current = true;
        setModal('account');
      }
    } catch (error) {
      if (order >= accountAccepted.current) {
        accountAccepted.current = order;
        setAccount((previous) =>
          previous ? { ...previous, authenticated: false, unavailable: true } : null,
        );
      }
      throw error;
    }
  }
  useEffect(() => {
    if (!connected || !status.features?.includes('accounts')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function pollAccount() {
      try {
        if (!cancelled) await refreshAccount();
      } catch {
        /* Account screen exposes reconnect without claiming a live credential. */
      } finally {
        if (!cancelled) timer = setTimeout(pollAccount, 2000);
      }
    }
    void pollAccount();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connected, status.features?.includes('accounts')]);
  const [showArchived, setShowArchived] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState('');
  const [settingsCatalog, setSettingsCatalog] = useState<Json>(null);
  const [settingsMessage, setSettingsMessage] = useState('');
  const settingsRequest = useRef('');
  const workspaceMenu = useRef<HTMLDetailsElement>(null);
  const [diagnosticReport, setDiagnosticReport] = useState('');
  const navigationStart = useRef<number | null>(null);
  const bootStart = useRef(performance.now());
  const bootMeasured = useRef(false);
  const snapshotVersion = useRef<string | undefined>(undefined);
  const snapshotRequest = useRef(0);
  const snapshotAccepted = useRef(0);
  const cameraFrame = useRef<number | null>(null);
  const [nodePreview, setNodePreview] = useState<{ id: string; x: number; y: number } | null>(null);
  const nodeDrag = useRef<{
    id: string;
    x: number;
    y: number;
    left: number;
    top: number;
    scrollX: number;
    scrollY: number;
    moved: boolean;
  } | null>(null);
  const suppressNodeClick = useRef<string | null>(null);
  const [mapWidth, setMapWidth] = useState(600);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const {
    drafts,
    setDrafts,
    flushDrafts,
    conflicts: draftConflicts,
    resolveConflict,
  } = useDurableDrafts(Boolean(connected && status.features?.includes('drafts')), setError);
  const relayDrafts = useDurableDrafts(
    Boolean(connected && status.features?.includes('relayDrafts')),
    setError,
    relayDraftStore,
  );
  const [draftToReview, setDraftToReview] = useState<string>();
  const [relayTarget, setRelayTarget] = useState<{ source: string; peer: string }>();
  const flushDraftsRef = useRef(flushDrafts);
  flushDraftsRef.current = async () => {
    await flushDrafts();
    await relayDrafts.flushDrafts();
  };
  const [startKind, setStartKind] = useState<'session' | 'project'>('session');
  // Saved Project revision the user chose to apply with the next task, per session.
  const [projectChoice, setProjectChoice] = useState<Record<string, number | undefined>>({});
  // Images staged for each session's next task, and a remount key after they are sent.
  const [images, setImages] = useState<Record<string, { ready: string[]; preparing: boolean }>>({});
  const [imageEpoch, setImageEpoch] = useState<Record<string, number>>({});
  const [imageDrop, setImageDrop] = useState<{ files: File[]; at: number }>();
  useEffect(() => {
    // Files dropped outside the composer must not navigate the app window to the file.
    const block = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);
  const [startFolder, setStartFolder] = useState('');
  const [folderPicking, setFolderPicking] = useState(false);
  const [modal, setModal] = useState<
      | 'rename'
      | 'start'
      | 'stop'
      | 'palette'
      | 'diagnostics'
      | 'settings'
      | 'account'
      | 'usage'
      | 'relay'
      | 'inbox'
      | 'help'
      | 'data'
      | 'search'
      | null
    >(null),
    [tab, setTab] = useState('transcript');
  const [review, setReview] = useState<{
    artifacts: Artifact[];
    evidence: Evidence[];
    nextOffset?: number | null;
    totalEvidence?: number;
  }>({
    artifacts: [],
    evidence: [],
  });
  const [artifactId, setArtifactId] = useState(''),
    [fresh, setFresh] = useState<{ fresh: boolean; checkedAtMillis: number } | null>(null);
  const [history, setHistory] = useState<Item[] | null>(null),
    [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0);
  const revision = useRef(0),
    loaded = useRef(false),
    dirty = useRef(false),
    modalRef = useRef<HTMLDialogElement>(null),
    mapRef = useRef<HTMLDivElement>(null);
  const latestPrefs = useRef(prefs);

  const pendingPrefs = useRef<{ id: string; params: Json } | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const mutationPending = useRef(false);
  const lastCommand = useRef<{ id: string; operation: string; params: Json } | null>(null);
  const session =
    status.sessions.find((s) => s.id === prefs.sessionId) ??
    status.sessions.find((s) => s.lifecycle !== 'archived') ??
    status.sessions[0];
  const sessionName = (row: SessionRow) =>
    (row.displayName === undefined ? prefs.sessionLabels?.[row.id] : row.displayName) ||
    (row.managedWorkspace?.source ?? row.workspace).split(/[\\/]/).filter(Boolean).at(-1) ||
    row.id;
  const newMessages = (status.relayUnread ?? []).filter((entry) =>
    status.sessions.some((row) => row.id === entry.sessionId),
  );
  const newMessageCount = newMessages.reduce((total, entry) => total + entry.count, 0);
  const selectedSession = useRef<string | undefined>(session?.id);
  selectedSession.current = session?.id;
  const nodes = session ? tasks(session, prefs) : [];
  const task = nodes.find((t) => t.id === prefs.selection) ?? nodes[0];
  const selectedTask = useRef(task?.id);
  selectedTask.current = task?.id;
  const queue = attention(
    { ...status, sessions: status.sessions.filter((s) => s.lifecycle !== 'archived') },
    prefs,
  );
  const candidate =
    review.artifacts.find((a) => a.id === artifactId) ??
    review.artifacts.filter((a) => a.taskId === task?.turnId).at(-1);
  const [capturedArtifact, setCapturedArtifact] = useState<Artifact>();
  const artifact = capturedArtifact?.id === candidate?.id ? capturedArtifact : undefined;
  useEffect(() => {
    let alive = true;
    setCapturedArtifact(undefined);
    if (candidate && session)
      void request<Artifact>('artifact/read', { sessionId: session.id, artifactId: candidate.id })
        .then((value) => {
          if (alive) setCapturedArtifact(value);
        })
        .catch((error) => {
          if (alive) setError(String(error));
        });
    return () => {
      alive = false;
    };
  }, [candidate?.id, session?.id]);
  useEffect(() => {
    let alive = true;
    if (candidate && session) {
      setReview((previous) => ({ ...previous, evidence: [], nextOffset: null }));
      void request('review/list', { sessionId: session.id, artifactId: candidate.id })
        .then((value) => {
          if (alive) setReview(value);
        })
        .catch((error) => {
          if (alive) setError(String(error));
        });
    }
    return () => {
      alive = false;
    };
  }, [candidate?.id, session?.id]);
  const available = connected && !!session?.state.current && session.lifecycle === 'connected';
  function acceptStatus(value: StatusReply, order: number) {
    if ('unchanged' in value) return;
    const current = snapshotVersion.current?.split(':');
    const next = value.version?.split(':');
    if (current && next && current[0] === next[0] && BigInt(next[1]) < BigInt(current[1])) return;
    if ((!current || !next || current[0] !== next[0]) && order < snapshotAccepted.current) return;
    snapshotAccepted.current = Math.max(snapshotAccepted.current, order);
    snapshotVersion.current = value.version;
    setStatus(value);
  }
  async function refresh() {
    const order = ++snapshotRequest.current;
    const value = await request<Status>('status');
    acceptStatus(value, order);
    setConnected(true);
    return value;
  }
  async function boot() {
    try {
      const order = ++snapshotRequest.current;
      acceptStatus(await connect(), order);
      setConnected(true);
      const saved = await request('presentation/get');
      revision.current = saved.revision;
      if (dirty.current) {
        throw new Error('Unsaved layout retained. Save it before reconnecting.');
      }
      latestPrefs.current = {
        theme: 'light',
        view: 'map',
        canvasControlsCollapsed: true,
        ...saved.value,
      };
      setPrefs(latestPrefs.current);
      loaded.current = true;
      setError('');
    } catch (e) {
      setError(String(e));
      setConnected(false);
    }
  }
  useEffect(() => {
    void boot();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!cancelled) {
          const order = ++snapshotRequest.current;
          const value = await request<StatusReply>(
            'status',
            snapshotVersion.current ? { since: snapshotVersion.current } : {},
          );
          if (!cancelled) {
            acceptStatus(value, order);
            setConnected(true);
            setError((previous) => (previous.startsWith('Disconnected:') ? '' : previous));
          }
        }
      } catch (e) {
        if (!cancelled) {
          setConnected(false);
          setError(`Disconnected: ${String(e)}`);
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  function updatePrefs(patch: Partial<Prefs>) {
    if (patch.selection !== undefined || patch.sessionId !== undefined)
      navigationStart.current = performance.now();
    dirty.current = true;
    const previous = latestPrefs.current;
    const next = {
      ...previous,
      ...patch,
      selection:
        patch.sessionId && patch.selection === undefined
          ? previous.selections?.[patch.sessionId]
          : (patch.selection ?? previous.selection),
      selections:
        patch.selection && patch.sessionId
          ? { ...previous.selections, [patch.sessionId]: patch.selection }
          : previous.selections,
    };
    latestPrefs.current = next;
    setPrefs(next);
  }

  useLayoutEffect(() => {
    if (navigationStart.current !== null) {
      recordTiming('navigationCommit', performance.now() - navigationStart.current);
      navigationStart.current = null;
    }
    if (
      !bootMeasured.current &&
      connected &&
      loaded.current &&
      (!session || session.state.current)
    ) {
      recordTiming('warmAttachCommit', performance.now() - bootStart.current);
      bootMeasured.current = true;
    }
  });

  function queueCamera(patch: Pick<Prefs, 'zoom' | 'canvasOffset' | 'viewport'>) {
    // The close flush sees the final input immediately, even before its frame.
    dirty.current = true;
    latestPrefs.current = { ...latestPrefs.current, ...patch };
    if (cameraFrame.current !== null) return;
    cameraFrame.current = requestAnimationFrame(() => {
      cameraFrame.current = null;
      setPrefs(latestPrefs.current);
    });
  }
  useEffect(
    () => () => {
      if (cameraFrame.current !== null) cancelAnimationFrame(cameraFrame.current);
    },
    [],
  );
  useCanvasGestures(
    mapRef,
    `${prefs.view}:${session?.id}`,
    () => {
      const value = latestPrefs.current;
      return {
        zoom: Math.max(0.02, Math.min(2, value.zoom ?? 1)),
        offset: {
          x: (value.canvasOffset?.x ?? 0) - (value.viewport?.x ?? 0),
          y: (value.canvasOffset?.y ?? 0) - (value.viewport?.y ?? 0),
        },
      };
    },
    (camera) =>
      queueCamera({ zoom: camera.zoom, canvasOffset: camera.offset, viewport: { x: 0, y: 0 } }),
    () => !loaded.current || Boolean(nodeDrag.current || pan.current),
  );

  async function flushPrefs() {
    if (saving.current) return saving.current;
    saving.current = (async () => {
      while (loaded.current && dirty.current) {
        dirty.current = false;
        try {
          pendingPrefs.current ??= {
            id: crypto.randomUUID(),
            params: { expectedRevision: revision.current, value: latestPrefs.current },
          };
          const pending = pendingPrefs.current;
          const saved = await request('presentation/save', pending.params, pending.id);
          pendingPrefs.current = null;
          if (pending.params.value !== latestPrefs.current) dirty.current = true;
          revision.current = saved.revision;
        } catch (error) {
          dirty.current = true;
          throw error;
        }
      }
    })();
    try {
      await saving.current;
    } finally {
      saving.current = null;
    }
  }
  useEffect(() => {
    if (!loaded.current || !dirty.current) return;
    const timer = setTimeout(() => {
      void flushPrefs().catch((e) => setError(`Layout was not saved: ${String(e)}`));
    }, 600);
    return () => clearTimeout(timer);
  }, [prefs]);
  // Pausing names every registered session from a fresh snapshot; a changed set is refused.
  async function pauseAll() {
    const fresh = await request<Status>('status');
    await request('stop', { sessions: fresh.sessions.map((s) => s.id) });
  }
  async function pauseIfPreferred() {
    if (latestPrefs.current.closeBehavior === 'pause') await pauseAll();
  }
  async function exitLascoria(choice: ExitChoice, remember: boolean) {
    if (remember && choice !== 'signOut') updatePrefs({ closeBehavior: choice });
    setBusy(true);
    setError('');
    try {
      await flushDraftsRef.current();
      await flushPrefs();
    } catch (e) {
      setBusy(false);
      setError(`Nothing was stopped because drafts or layout could not be saved: ${String(e)}`);
      return;
    }
    try {
      if (choice === 'signOut') await request('account/logout', {});
      if (choice !== 'keepRunning') await pauseAll();
    } catch (e) {
      setBusy(false);
      setError(
        choice === 'signOut'
          ? `Sign-out or pausing could not be confirmed: ${String(e)}. Check Muse account before retrying.`
          : `Work could not be paused: ${String(e)}. Refresh and try again.`,
      );
      return;
    }
    setBusy(false);
    if ((window as any).__TAURI_INTERNALS__?.metadata) {
      await getCurrentWindow().destroy();
      return;
    }
    setModal(null);
    if (choice !== 'keepRunning') setConnected(false);
    setNotice(
      choice === 'keepRunning'
        ? 'You can close this window. Work continues in the background.'
        : 'Lascoria stopped. Close the window, or reconnect to resume saved sessions.',
    );
  }
  useEffect(() => {
    // Native window close flushes presentation only; execution belongs to the supervisor.
    if (!(window as any).__TAURI_INTERNALS__?.metadata) return;
    let disposed = false;
    let unlisten: undefined | (() => void);
    let unlistenQuit: undefined | (() => void);
    void listen('lascoria-before-quit', async () => {
      try {
        await flushDraftsRef.current();
        await flushPrefs();
        await pauseIfPreferred();
        await invoke('finish_quit');
      } catch (e) {
        setError(`Quit paused because drafts, layout or work could not be saved: ${String(e)}`);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenQuit = fn;
    });
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await flushDraftsRef.current();
          await flushPrefs();
          await pauseIfPreferred();
          await getCurrentWindow().destroy();
        } catch (e) {
          setError(`Close paused because drafts, layout or work could not be saved: ${String(e)}`);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
      unlistenQuit?.();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme ?? 'light';
  }, [prefs.theme]);
  useEffect(() => {
    if (modal) modalRef.current?.showModal();
    else modalRef.current?.close();
  }, [modal]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setModal('palette');
      }
      if (e.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    if (mapRef.current && prefs.viewport) {
      mapRef.current.scrollLeft = prefs.viewport.x;
      mapRef.current.scrollTop = prefs.viewport.y;
    }
  }, [prefs.view, session?.id]);
  useEffect(() => {
    const element = mapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setMapWidth(element.clientWidth));
    observer.observe(element);
    setMapWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [prefs.view, session?.id]);
  async function loadReview() {
    if (!session) return;
    const value = await request('review/list', {
      sessionId: session.id,
      ...(candidate ? { artifactId: candidate.id } : {}),
    });
    if (selectedSession.current === session.id) setReview(value);
  }
  useEffect(() => {
    setArtifactId('');
    setFresh(null);
    setReview({ artifacts: [], evidence: [] });
    let alive = true;
    if (session)
      void request('review/list', { sessionId: session.id })
        .then((value) => {
          if (alive) setReview(value);
        })
        .catch((e) => {
          if (alive) setError(String(e));
        });
    return () => {
      alive = false;
    };
  }, [session?.id, task?.id]);
  useEffect(() => {
    let alive = true;
    setFresh(null);
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (!artifact || !session) return;
      try {
        const value = await request('artifact/check', {
          sessionId: session.id,
          artifactId: artifact.id,
        });
        if (alive) setFresh(value);
      } catch (e) {
        if (alive) {
          setFresh(null);
          setError(String(e));
        }
      } finally {
        if (alive) timer = setTimeout(check, 3000);
      }
    };
    if (tab === 'diff' || tab === 'evidence') void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [artifact?.id, session?.id, tab]);
  useEffect(() => {
    setHistory(null);
    setOffset(0);
    setTotal(session?.state.totalItems ?? 0);
  }, [task?.id]);
  // D3: save the messages Lascoria keeps for a session as Markdown, through the native chooser.
  async function exportTranscript(row: SessionRow) {
    const slug =
      sessionName(row)
        .replace(/[^A-Za-z0-9 _-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 80) || 'session';
    try {
      const path = await invoke<string | null>('pick_transcript_destination', {
        suggested: `${slug}-transcript.md`,
      });
      if (!path) return;
      const result = await request<{ messages: number }>('data/transcript', {
        sessionId: row.id,
        path,
      });
      setNotice(
        `Transcript saved · ${result.messages} messages. It contains your conversation, so store it privately.`,
      );
    } catch (e) {
      setError(`Transcript not saved: ${String(e).replace(/^Error: /, '')}`);
    }
  }
  async function mutate(operation: string, params: Json) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    setError('');
    const id = crypto.randomUUID();
    let dispatched = false;
    lastCommand.current = null;
    try {
      if (operation === 'session/archive' || operation === 'stop') await flushDraftsRef.current();
      lastCommand.current = { id, operation, params };
      dispatched = true;
      const result = await request(operation, params, id);
      const names: Record<string, string> = {
        start: 'Session',
        turn: 'Task',
        steer: 'Steering',
        cancel: 'Cancellation',
        decide: 'Permission decision',
        answer: 'Answer',
        resume: 'Recovery',
        setModel: 'Model change',
        setEffort: 'Effort change',
        'artifact/capture': 'Diff capture',
        'evidence/record': 'Evidence',
      };
      setNotice(`${names[operation] ?? operation} · ${result.status ?? 'saved'}`);
      if (operation !== 'stop') await refresh();
      if (operation === 'turn' && result.result?.turnId)
        updatePrefs({
          selection: `${params.sessionId}:${result.result.turnId}`,
          sessionId: params.sessionId,
        });
      return result;
    } catch (e) {
      setError(
        dispatched
          ? `${String(e)} Request ${id}. Inspect the journal before repeating an uncertain action.`
          : String(e),
      );
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }
  function select(node: Task) {
    updatePrefs({ selection: node.id, sessionId: node.sessionId });
    setTab('transcript');
    openInspector();
  }
  async function page() {
    if (!session) return;
    const taskId = task?.id;
    const sessionId = session.id;
    try {
      const value = await request('transcript', {
        sessionId: session.id,
        ...(task?.childSessionId ? { childSessionId: task.childSessionId } : {}),
        offset,
      });
      if (selectedTask.current !== taskId || selectedSession.current !== sessionId) return;
      setHistory(value.items);
      setTotal(value.totalItems);
      setOffset(value.nextOffset ?? 0);
    } catch (e) {
      setError(String(e));
    }
  }
  const items = (history ?? (task?.childSessionId ? [] : (session?.state.items ?? []))).filter(
    (i) => task?.childSessionId || !task?.turnId || i.turnId === task.turnId,
  );
  const transcriptItems = items.filter(
    (item) =>
      prefs.showRuntimeReminders ||
      item.kind !== 'reminderChild' ||
      item.itemId === task?.item?.itemId ||
      ['failed', 'rejected'].includes(item.status),
  );
  const itemStatusLabels: Record<string, string> = {
    inProgress: 'In progress',
    timedOut: 'Timed out',
    failed: 'Failed',
    cancelled: 'Cancelled',
    rejected: 'Rejected',
  };
  const itemLabels: Record<string, string> = {
    userMessage: 'You',
    skillRead: 'Skill',
    agentMessage: 'Muse',
    reminderChild: 'Background activity',
    toolCall: 'Tool execution',
    workflow: 'Workflow',
    plan: 'Plan',
  };
  const visible = nodes.filter(
    (n) =>
      (n.item?.kind !== 'reminderChild' ||
        prefs.showRuntimeReminders ||
        n.id === task?.id ||
        ['failed', 'rejected'].includes(n.status)) &&
      (!prefs.collapsed?.includes(n.id) || n.id === task?.id) &&
      n.label.toLowerCase().includes((prefs.search ?? '').toLowerCase()),
  );
  // Scene coordinates belong to the constellation, not floating panels or the viewport.
  // Keep filtered nodes in the layout so disclosure/search cannot move their neighbours.
  const layout = constellationLayout(nodes, 1800);
  const zoom = Math.max(0.02, Math.min(2, prefs.zoom ?? 1));
  const canvasOffset = prefs.canvasOffset ?? { x: 0, y: 0 };
  const position = (node: Task, _index: number) =>
    nodePreview?.id === node.id ? nodePreview : (prefs.positions?.[node.id] ?? layout[node.id]);
  const sceneWidth = Math.max(
    mapWidth,
    1800,
    ...visible.map((node, index) => position(node, index).x + 260),
  );
  const sceneHeight = Math.max(
    1400,
    ...visible.map((node, index) => position(node, index).y + 180),
  );
  useEffect(() => {
    if (mapRef.current && prefs.viewport)
      mapRef.current.scrollTo({ left: prefs.viewport.x, top: prefs.viewport.y });
  }, [prefs.zoom, prefs.canvasOffset]);
  useEffect(() => {
    nodeDrag.current = null;
    setNodePreview(null);
  }, [session?.id]);
  function changeZoom(next: number) {
    const element = mapRef.current;
    if (!element) return;
    const value = latestPrefs.current;
    const camera = zoomAtPoint(
      {
        zoom: value.zoom ?? 1,
        offset: {
          x: (value.canvasOffset?.x ?? 0) - (value.viewport?.x ?? 0),
          y: (value.canvasOffset?.y ?? 0) - (value.viewport?.y ?? 0),
        },
      },
      next,
      { x: element.clientWidth / 2, y: element.clientHeight / 2 },
    );
    updatePrefs({ zoom: camera.zoom, canvasOffset: camera.offset, viewport: { x: 0, y: 0 } });
  }
  function finishNodeDrag(commit: boolean) {
    const drag = nodeDrag.current;
    if (!drag) return;
    nodeDrag.current = null;
    if (commit && drag.moved && nodePreview) {
      suppressNodeClick.current = drag.id;
      setTimeout(() => {
        suppressNodeClick.current = null;
      }, 0);
      updatePrefs({
        positions: {
          ...latestPrefs.current.positions,
          [drag.id]: { x: nodePreview.x, y: nodePreview.y },
        },
      });
    }
    setNodePreview(null);
  }
  async function capture() {
    if (!session || !task?.turnId) return;
    const value = await mutate('artifact/capture', { sessionId: session.id, taskId: task.turnId });
    if (value) {
      await loadReview();
      setArtifactId(value.id);
      setTab('diff');
    }
  }
  const panelChange = (name: string, value: PanelLayout) =>
    updatePrefs({ panels: { ...latestPrefs.current.panels, [name]: value } });
  const openInspector = () =>
    panelChange('inspector', {
      x: window.innerWidth - 440,
      y: 150,
      ...latestPrefs.current.panels?.inspector,
      collapsed: false,
    });
  useEffect(() => {
    if (!/ · (accepted|applied|saved)$/.test(notice)) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const menu = workspaceMenu.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  const isHistoricalInterruption = (entry: (typeof queue)[number]) =>
    entry.kind === 'interruption' && 'historical' in entry && entry.historical === true;
  const renderAttention = (entry: (typeof queue)[number]) => (
    <button
      key={entry.id}
      className="attention-row"
      onClick={() => {
        updatePrefs({ sessionId: entry.sessionId, selection: entry.target });
        setTab(entry.kind === 'review' ? 'diff' : 'transcript');
        openInspector();
      }}
    >
      <span className={`attention-icon ${entry.kind}`}>
        {entry.kind === 'approval'
          ? '!'
          : entry.kind === 'question'
            ? '?'
            : entry.kind === 'review'
              ? '↗'
              : '×'}
      </span>
      <span>
        <small title={sessionName(status.sessions.find((row) => row.id === entry.sessionId)!)}>
          {entry.kind} · {short(entry.sessionId)} ·{' '}
          {sessionName(status.sessions.find((row) => row.id === entry.sessionId)!)}
        </small>
        <strong>{entry.label}</strong>
      </span>
    </button>
  );
  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href="#workspace" aria-label="Lascoria workspace">
          <img className="brand-mark" src="/brand/lascoria-mark.svg" alt="" />
          <span className="brand-name">lascoria</span>
          <span className="edition">SPATIAL CODING</span>
        </a>
        <div className="top-actions">
          {newMessageCount > 0 && (
            <button
              className="message-discovery"
              disabled={!connected}
              onClick={() => setModal('inbox')}
            >
              {newMessageCount} new {newMessageCount === 1 ? 'message' : 'messages'}
            </button>
          )}
          {Object.keys(draftConflicts).length + Object.keys(relayDrafts.conflicts).length > 0 && (
            <button
              onClick={() => {
                const target = Object.keys(draftConflicts)[0];
                if (target) {
                  setDraftToReview(target);
                  updatePrefs({ sessionId: target, selection: undefined });
                  setTab('transcript');
                  openInspector();
                } else {
                  const [source, peer] = Object.keys(relayDrafts.conflicts)[0].split(':');
                  updatePrefs({ sessionId: source, selection: undefined });
                  setRelayTarget({ source, peer });
                  setModal('relay');
                }
              }}
            >
              Review drafts (
              {Object.keys(draftConflicts).length + Object.keys(relayDrafts.conflicts).length})
            </button>
          )}
          <span className={`connection ${connected ? 'live' : ''}`}>
            {connected ? 'Supervisor connected' : 'Disconnected'}
          </span>
          <button
            className="account-status"
            disabled={!status.features?.includes('accounts')}
            onClick={() => {
              void refreshAccount().catch(() => {});
              setModal('account');
            }}
          >
            {account?.managed
              ? account.authenticated
                ? account.mode === 'subscription'
                  ? 'Muse subscription'
                  : 'API billing'
                : 'Sign in'
              : 'Muse account'}
          </button>
          <button onClick={() => setModal('palette')} aria-label="Open command palette">
            {navigator.platform.startsWith('Mac') ? '⌘ K' : 'Ctrl K'}
          </button>
          <details
            className="workspace-menu"
            ref={workspaceMenu}
            onToggle={(event) => {
              if (!event.currentTarget.open || !session?.state.current) return;
              if (!status.features?.includes('usage') || account?.mode === 'apiKey') return;
              if (menuUsage?.sessionId === session.id && Date.now() - menuUsage.readAtMs < 60_000)
                return;
              const sessionId = session.id;
              void request<{
                usage?: { weekly: { usedPercent: number }; observedAtMs: number };
              }>('usage', { sessionId }).then(
                (result) =>
                  setMenuUsage(
                    result.usage
                      ? {
                          sessionId,
                          weeklyRemaining: Math.max(0, 100 - result.usage.weekly.usedPercent),
                          observedAtMs: result.usage.observedAtMs,
                          readAtMs: Date.now(),
                        }
                      : null,
                  ),
                () => setMenuUsage(null),
              );
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && event.currentTarget.open) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.open = false;
                event.currentTarget.querySelector('summary')?.focus();
              }
            }}
            onBlur={(event) => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
                event.currentTarget.open = false;
            }}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button')) event.currentTarget.open = false;
            }}
          >
            <summary aria-label="Workspace menu">•••</summary>
            <div className="workspace-menu-items">
              {account?.managed && (
                <div className="menu-identity">
                  <span className="menu-avatar" aria-hidden="true">
                    {(account.subscription?.label ?? (account.mode === 'apiKey' ? 'API' : 'M'))
                      .trim()
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                  <span>
                    <strong>
                      {account.authenticated
                        ? account.mode === 'subscription'
                          ? (account.subscription?.label ?? 'Muse subscription')
                          : 'Meta API key'
                        : 'Signed out'}
                    </strong>
                    <small>
                      {account.authenticated
                        ? account.mode === 'subscription'
                          ? account.subscription?.label
                            ? 'Muse subscription'
                            : 'Account name not reported by Muse'
                          : 'API billing with your provider'
                        : 'Sign in to start new work'}
                    </small>
                  </span>
                </div>
              )}
              <span className="eyebrow">Workspace</span>
              <button
                disabled={!status.features?.includes('accounts')}
                onClick={() => {
                  void refreshAccount().catch(() => {});
                  setModal('account');
                }}
              >
                Muse account
              </button>
              <button
                onClick={() => updatePrefs({ theme: prefs.theme === 'light' ? 'dark' : 'light' })}
              >
                {prefs.theme === 'light' ? 'Dark' : 'Light'}
              </button>
              {status.features?.includes('localRelay') && (
                <button disabled={!session} onClick={() => setModal('relay')}>
                  Local messages
                </button>
              )}
              <button
                disabled={!session || !status.features?.includes('usage')}
                onClick={() => setModal('usage')}
                title={
                  menuUsage?.sessionId === session?.id && menuUsage
                    ? `Weekly allowance as of ${new Date(menuUsage.observedAtMs).toLocaleString()}`
                    : undefined
                }
              >
                Usage
                {menuUsage && menuUsage.sessionId === session?.id && (
                  <span className="menu-usage"> · {menuUsage.weeklyRemaining}% weekly left</span>
                )}
              </button>
              {status.features?.includes('search') && (
                <button onClick={() => setModal('search')}>Search history</button>
              )}
              {status.features?.includes('dataLifecycle') && (
                <button onClick={() => setModal('data')}>Data &amp; backups</button>
              )}
              <button onClick={() => setModal('help')}>Help</button>
              <button onClick={() => updatePrefs({ panels: {} })}>Reset panels</button>
              <button
                disabled={!status.features?.includes('diagnostics')}
                title={
                  status.features?.includes('diagnostics')
                    ? 'Local performance report'
                    : 'Restart the supervisor to enable diagnostics'
                }
                onClick={async () => {
                  setDiagnosticReport('Loading diagnostics...');
                  setModal('diagnostics');
                  try {
                    const supervisor = await request('diagnostics');
                    setDiagnosticReport(
                      JSON.stringify(
                        {
                          schemaVersion: 1,
                          capturedAt: new Date().toISOString(),
                          ui: timingSnapshot(),
                          supervisor,
                          workers: status.sessions.map((s) => ({
                            modelRoute: s.state.modelRoute,
                            ...s.state.diagnostics,
                          })),
                        },
                        null,
                        2,
                      ),
                    );
                  } catch (e) {
                    setDiagnosticReport(`Diagnostics unavailable: ${String(e)}`);
                  }
                }}
              >
                Diagnostics
              </button>
              <button onClick={() => setModal('stop')}>Log out…</button>
            </div>
          </details>
        </div>
      </header>
      {session && (
        <aside className="sidebar">
          <FloatingPanel
            title="Sessions"
            layout={prefs.panels?.sessions}
            initial={{ x: 16, y: 150 }}
            onChange={(value) => panelChange('sessions', value)}
          >
            <div className="section-heading">
              <h2>Sessions</h2>
              <button onClick={() => setModal('start')} aria-label="Start a session">
                ＋
              </button>
            </div>
            <label className="row">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />{' '}
              Show archived sessions
            </label>
            <nav aria-label="Sessions">
              {status.sessions
                .filter((s) => showArchived || s.lifecycle !== 'archived' || s.id === session?.id)
                .map((s) => (
                  <button
                    key={s.id}
                    className={`session-card ${session?.id === s.id ? 'selected' : ''}`}
                    onClick={() => updatePrefs({ sessionId: s.id, selection: undefined })}
                  >
                    <span className="eyebrow">SESSION · {short(s.id)}</span>
                    {s.state.modelRoute?.modelId && <small>{s.state.modelRoute.modelId}</small>}
                    <strong title={sessionName(s)}>{sessionName(s)}</strong>
                    <span>
                      {s.state.current ? (s.state.activeTurnId ? 'Running' : 'Idle') : s.lifecycle}{' '}
                      · {queue.filter((q) => q.sessionId === s.id).length} attention
                    </span>
                  </button>
                ))}
            </nav>
          </FloatingPanel>
          <FloatingPanel
            title="Attention"
            badge={queue.length}
            layout={prefs.panels?.attention}
            initial={{ x: 16, y: 460 }}
            onChange={(value) => panelChange('attention', value)}
          >
            <section className="attention" aria-labelledby="attention-heading">
              <div className="section-heading">
                <h2 id="attention-heading">Attention</h2>
                <span className="count">{queue.length}</span>
              </div>
              {queue.length === 0 ? (
                <p className="muted">Nothing needs attention.</p>
              ) : (
                <>
                  {queue.filter((entry) => !isHistoricalInterruption(entry)).map(renderAttention)}
                  {queue.some(isHistoricalInterruption) && (
                    <details className="attention-history">
                      <summary>
                        Runtime history <span>{queue.filter(isHistoricalInterruption).length}</span>
                      </summary>
                      {queue.filter(isHistoricalInterruption).map(renderAttention)}
                    </details>
                  )}
                </>
              )}
            </section>
          </FloatingPanel>
          <div className="sidebar-foot">
            LOCAL EXECUTION
            <br />
            <span>Muse · local execution</span>
          </div>
        </aside>
      )}
      <main id="workspace">
        {session && (
          <div className="workspace-title">
            <div>
              <p className="eyebrow">{session?.workspace ?? 'YOUR LOCAL WORKSPACE'}</p>
              <h1 title={sessionName(session)}>{sessionName(session)}</h1>
              <div className="session-identity-actions">
                {status.features?.includes('sessionNames') && (
                  <button className="session-settings-trigger" onClick={() => setModal('rename')}>
                    Rename session
                  </button>
                )}
                {status.features?.includes('transcriptExport') && (
                  <button
                    className="session-settings-trigger"
                    onClick={() => void exportTranscript(session)}
                  >
                    Export transcript…
                  </button>
                )}
                {session.projectContext && (
                  <details className="project-context">
                    <summary title={session.projectContext.name}>
                      {session.projectContext.folders.length} folders
                    </summary>
                    <div
                      className="project-context-popover"
                      role="region"
                      aria-label="Project folders"
                    >
                      <strong>{session.projectContext.name}</strong>
                      <p>
                        {session.projectContextReceipt?.status !== 'applied'
                          ? 'Requested folders; native start not confirmed'
                          : session.projectContextReceipt.appliedWith === 'turn'
                            ? 'Applied with a later task'
                            : 'Applied at session start'}{' '}
                        · revision {session.projectContext.revision}
                      </p>
                      <ol>
                        {session.projectContext.folders.map((folder, i) => (
                          <li key={folder.id}>
                            <strong>
                              {folder.name}
                              {i === 0 ? ' (default)' : ''}
                            </strong>
                            <code>{folder.path}</code>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </details>
                )}
              </div>
              <p className="muted">Tasks, decisions and the evidence behind a change.</p>
            </div>
            <button className="primary" onClick={() => setModal('start')}>
              New session
            </button>
          </div>
        )}
        <div className="notification-stack" role="region" aria-label="Workspace notifications">
          {error && (
            <div className="banner error" role="alert">
              {error}
              <button onClick={() => void boot()}>Reconnect</button>
            </div>
          )}
          {notice && (
            <div className="banner" role="status">
              {notice}
              <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
                ×
              </button>
            </div>
          )}
          {session && session.lifecycle === 'archived' && (
            <div className="banner archived" role="status">
              {(() => {
                const continuation = status.sessions.find((s) => s.continuedFrom === session.id);
                const folder = session.workspaceDiscarded
                  ? session.managedWorkspace?.source
                  : (session.managedWorkspace?.path ?? session.workspace);
                return (
                  <>
                    <span>
                      Archived session. Its transcript and saved changes are read-only.
                      {session.projectContext
                        ? ' Start a new Project session to continue this work.'
                        : ''}
                    </span>
                    {continuation ? (
                      <button
                        onClick={() =>
                          updatePrefs({ sessionId: continuation.id, selection: undefined })
                        }
                      >
                        Open continued session
                      </button>
                    ) : (
                      status.features?.includes('continuation') &&
                      !session.projectContext &&
                      folder && (
                        <button
                          disabled={busy}
                          title={`Starts a new session in ${folder}`}
                          onClick={async () => {
                            const result = await mutate('start', {
                              workspace: folder,
                              name: `${sessionName(session).slice(0, 88)} (continued)`,
                              isolated: false,
                              continuedFrom: session.id,
                            });
                            if (result?.status === 'applied')
                              updatePrefs({ sessionId: result.sessionId, selection: undefined });
                          }}
                        >
                          Continue in a new session
                        </button>
                      )
                    )}
                  </>
                );
              })()}
            </div>
          )}
          {session && session.continuedFrom && session.lifecycle !== 'archived' && (
            <div className="banner" role="status">
              Continues archived work from{' '}
              {(() => {
                const prior = status.sessions.find((s) => s.id === session.continuedFrom);
                return prior ? sessionName(prior) : `session ${short(session.continuedFrom!)}`;
              })()}
              .
              <button
                onClick={() => {
                  setShowArchived(true);
                  updatePrefs({ sessionId: session.continuedFrom, selection: undefined });
                }}
              >
                View archive
              </button>
            </div>
          )}
          {session && !available && session.lifecycle !== 'archived' && (
            <div className="banner error">
              State is unavailable. Controls are disabled until recovery completes.
              <button
                disabled={busy}
                onClick={() => void mutate('resume', { sessionId: session.id })}
              >
                Recover session
              </button>
            </div>
          )}
        </div>
        {!session ? (
          <section className="empty-state">
            <img className="brand-mark large-mark" src="/brand/lascoria-mark.svg" alt="" />
            <p className="eyebrow">THE SPATIAL CODING WORKSPACE</p>
            <h1>Give your agents room to work.</h1>
            <p>
              Open an existing Git repository, give Muse a task, and keep its decisions and changes
              in view.
            </p>
            <button className="primary" onClick={() => setModal('start')}>
              Start your first session
            </button>
          </section>
        ) : (
          <>
            <div className="workspace-grid">
              <section className="task-surface">
                <div
                  className={`surface-toolbar ${prefs.canvasControlsCollapsed ? 'is-collapsed' : ''}`}
                  role="region"
                  aria-label="Canvas controls"
                >
                  <div className="canvas-dock-heading">
                    <span className="eyebrow">
                      Canvas{' '}
                      <span className="dock-zoom">
                        · {prefs.view === 'list' ? 'List' : `${Math.round(zoom * 100)}%`}
                      </span>
                    </span>
                    <button
                      aria-label={
                        prefs.canvasControlsCollapsed
                          ? 'Expand canvas controls'
                          : 'Collapse canvas controls'
                      }
                      aria-expanded={!prefs.canvasControlsCollapsed}
                      disabled={!loaded.current}
                      onClick={() =>
                        updatePrefs({ canvasControlsCollapsed: !prefs.canvasControlsCollapsed })
                      }
                    >
                      {prefs.canvasControlsCollapsed ? 'Show tools' : 'Hide tools'}
                    </button>
                  </div>
                  <div className="canvas-tools" hidden={!!prefs.canvasControlsCollapsed}>
                    {status.features?.includes('relayMap') && (
                      <button
                        onClick={() => {
                          panelChange('connections', {
                            x:
                              prefs.panels?.connections?.x ??
                              Math.max(16, window.innerWidth / 2 - 210),
                            y: prefs.panels?.connections?.y ?? 160,
                            collapsed: false,
                          });
                          updatePrefs({ canvasControlsCollapsed: true });
                        }}
                      >
                        Session links
                      </button>
                    )}
                    <button
                      onClick={() => {
                        mapRef.current?.scrollTo({ left: 0, top: 0 });
                        updatePrefs({ canvasOffset: { x: 0, y: 0 }, viewport: { x: 0, y: 0 } });
                      }}
                    >
                      Recenter canvas
                    </button>
                    <button
                      disabled={prefs.view === 'list' || zoom <= 0.02}
                      aria-label="Zoom out"
                      onClick={() => changeZoom(zoom / 1.25)}
                    >
                      −
                    </button>
                    <button
                      disabled={prefs.view === 'list'}
                      aria-label="Reset zoom to 100 percent"
                      onClick={() => changeZoom(1)}
                    >
                      {Math.round(zoom * 100)}%
                    </button>
                    <button
                      disabled={prefs.view === 'list' || zoom >= 2}
                      aria-label="Zoom in"
                      onClick={() => changeZoom(zoom * 1.25)}
                    >
                      +
                    </button>
                    <button
                      disabled={prefs.view === 'list' || !visible.length}
                      onClick={() => {
                        const element = mapRef.current;
                        if (!element) return;
                        const canvas = element.getBoundingClientRect();
                        const obstacles = [
                          ...document.querySelectorAll(
                            '.floating-panel, .surface-toolbar, .surface-foot, .layout-controls',
                          ),
                        ].map((panel) => {
                          const box = panel.getBoundingClientRect();
                          return {
                            x: box.left - canvas.left,
                            y: box.top - canvas.top,
                            width: box.width,
                            height: box.height,
                          };
                        });
                        const frame = freeCanvasFrame(
                          element.clientWidth,
                          element.clientHeight,
                          obstacles,
                        );
                        if (!frame.width) {
                          setNotice('Move or collapse a panel to make room for fit-to-view.');
                          return;
                        }
                        const points = visible.map((node, index) => position(node, index));
                        const fit = fitConstellation(
                          points,
                          element.clientWidth,
                          element.clientHeight,
                          frame,
                        );
                        if (
                          points.some(
                            (point) =>
                              point.x * fit.zoom + fit.offset.x < frame.x ||
                              (point.x + 220) * fit.zoom + fit.offset.x > frame.x + frame.width ||
                              point.y * fit.zoom + fit.offset.y < frame.y ||
                              (point.y + 140) * fit.zoom + fit.offset.y > frame.y + frame.height,
                          )
                        ) {
                          setNotice(
                            'Move or collapse a panel to fit all visible nodes at the minimum zoom.',
                          );
                          return;
                        }
                        updatePrefs({
                          zoom: fit.zoom,
                          canvasOffset: fit.offset,
                          viewport: { x: 0, y: 0 },
                        });
                      }}
                    >
                      Fit to view
                    </button>
                    <div className="segmented">
                      <button
                        aria-pressed={prefs.view !== 'list'}
                        onClick={() => updatePrefs({ view: 'map' })}
                      >
                        Task map
                      </button>
                      <button
                        aria-pressed={prefs.view === 'list'}
                        onClick={() => updatePrefs({ view: 'list' })}
                      >
                        List
                      </button>
                    </div>
                    <label className="search">
                      <span>Search tasks</span>
                      <input
                        value={prefs.search ?? ''}
                        onChange={(e) => updatePrefs({ search: e.target.value })}
                        placeholder="Filter tasks…"
                      />
                    </label>
                    <label className="runtime-filter">
                      <input
                        type="checkbox"
                        checked={prefs.showRuntimeReminders ?? false}
                        onChange={(event) =>
                          updatePrefs({ showRuntimeReminders: event.target.checked })
                        }
                      />
                      Runtime reminders
                    </label>
                    <button
                      onClick={() =>
                        updatePrefs({
                          collapsed: nodes.filter((n) => n.status === 'completed').map((n) => n.id),
                        })
                      }
                    >
                      Collapse completed
                    </button>
                    <button onClick={() => updatePrefs({ collapsed: [] })}>Expand</button>
                  </div>
                </div>
                {prefs.view === 'list' ? (
                  <ul className="task-list" aria-label="Task list">
                    {visible.map((node) => (
                      <li key={node.id}>
                        <button aria-current={task?.id === node.id} onClick={() => select(node)}>
                          <span className={`status-dot ${node.status}`} />
                          <strong>{node.label}</strong>
                          <span>{node.status}</span>
                          <small>
                            {node.provenance === 'derived' ? 'Turn grouping' : node.item?.kind} ·{' '}
                            {node.provenance === 'derived'
                              ? 'session owner'
                              : (node.item?.role ?? 'owner unavailable')}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div
                    className="map-scroll"
                    title="Two-finger scroll to pan; pinch or Ctrl/Cmd+wheel to zoom"
                    role="region"
                    aria-label="Constellation canvas"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      const steps: Record<string, [number, number]> = {
                        ArrowLeft: [-80, 0],
                        ArrowRight: [80, 0],
                        ArrowUp: [0, -80],
                        ArrowDown: [0, 80],
                      };
                      if (!steps[event.key]) return;
                      event.preventDefault();
                      const [left, top] = steps[event.key];
                      updatePrefs({
                        canvasOffset: {
                          x: canvasOffset.x - event.currentTarget.scrollLeft - left,
                          y: canvasOffset.y - event.currentTarget.scrollTop - top,
                        },
                        viewport: { x: 0, y: 0 },
                      });
                    }}
                    ref={mapRef}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || (event.target as HTMLElement).closest('button'))
                        return;
                      const element = event.currentTarget;
                      pan.current = {
                        x: event.clientX,
                        y: event.clientY,
                        left: canvasOffset.x - element.scrollLeft,
                        top: canvasOffset.y - element.scrollTop,
                      };
                      updatePrefs({
                        canvasOffset: { x: pan.current.left, y: pan.current.top },
                        viewport: { x: 0, y: 0 },
                      });
                      element.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (!pan.current) return;
                      queueCamera({
                        canvasOffset: {
                          x: pan.current.left + event.clientX - pan.current.x,
                          y: pan.current.top + event.clientY - pan.current.y,
                        },
                        viewport: { x: 0, y: 0 },
                      });
                    }}
                    onPointerUp={() => {
                      pan.current = null;
                    }}
                    onPointerCancel={() => {
                      pan.current = null;
                    }}
                    onLostPointerCapture={() => {
                      pan.current = null;
                    }}
                    onScroll={(e) =>
                      updatePrefs({
                        viewport: { x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop },
                      })
                    }
                  >
                    <div
                      className="map-stage"
                      style={{
                        width: Math.max(mapWidth, sceneWidth * zoom + canvasOffset.x),
                        height: Math.max(
                          mapRef.current?.clientHeight ?? 600,
                          sceneHeight * zoom + canvasOffset.y,
                        ),
                      }}
                    >
                      <div
                        className="task-map"
                        style={{
                          width: sceneWidth,
                          height: sceneHeight,
                          left: canvasOffset.x,
                          top: canvasOffset.y,
                          transform: `scale(${zoom})`,
                          transformOrigin: '0 0',
                        }}
                        aria-label="Task map"
                      >
                        <svg className="edges" width="100%" height="100%" aria-hidden="true">
                          {visible.flatMap((node, index) => {
                            const parent = visible.findIndex((n) => n.id === node.parentId);
                            if (parent < 0) return [];
                            const a = position(visible[parent], parent),
                              b = position(node, index);
                            return [
                              <path
                                key={node.id}
                                d={`M ${a.x + 110} ${a.y + 114} C ${a.x + 110 + (Math.abs(a.x - b.x) < 30 ? 24 : 0)} ${a.y + 150}, ${b.x + 110 + (Math.abs(a.x - b.x) < 30 ? 24 : 0)} ${b.y - 36}, ${b.x + 110} ${b.y}`}
                                className="native-edge"
                              />,
                            ];
                          })}
                          {(prefs.edges ?? []).map((edge) => {
                            const a = visible.findIndex((n) => n.id === edge.from),
                              b = visible.findIndex((n) => n.id === edge.to);
                            if (a < 0 || b < 0) return null;
                            const p = position(visible[a], a),
                              q = position(visible[b], b);
                            const direction = q.x >= p.x ? 1 : -1;
                            const startX = p.x + (direction > 0 ? 220 : 0);
                            const endX = q.x + (direction > 0 ? 0 : 220);
                            const handle = Math.max(
                              24,
                              Math.min(80, Math.abs(endX - startX) * 0.45),
                            );
                            const bow = Math.abs(p.y - q.y) < 30 ? -24 : 0;
                            return (
                              <g key={edge.id}>
                                <path
                                  d={`M ${startX} ${p.y + 55} C ${startX + direction * handle} ${p.y + 55 + bow}, ${endX - direction * handle} ${q.y + 55 + bow}, ${endX} ${q.y + 55}`}
                                  className="asserted-edge"
                                />
                                <text
                                  x={(startX + endX) / 2}
                                  y={bow ? Math.min(p.y, q.y) - 12 : (p.y + q.y) / 2 + 45}
                                >
                                  {edge.kind} · user
                                </text>
                              </g>
                            );
                          })}
                        </svg>
                        {visible.map((node, index) => {
                          const p = position(node, index);
                          const activity = nodeActivity(node, session, connected);
                          return (
                            <button
                              key={node.id}
                              className={`task-node ${task?.id === node.id ? 'selected' : ''} activity-${activity.kind}`}
                              aria-busy={activity.busy}
                              data-activity={activity.kind}
                              style={{ left: p.x, top: p.y }}
                              title="Drag to arrange; Shift+arrow keys move; arrow keys navigate"
                              onPointerDown={(event) => {
                                if (event.button !== 0) return;
                                event.stopPropagation();
                                event.preventDefault();
                                event.currentTarget.setPointerCapture(event.pointerId);
                                nodeDrag.current = {
                                  id: node.id,
                                  x: event.clientX,
                                  y: event.clientY,
                                  left: p.x,
                                  top: p.y,
                                  scrollX: mapRef.current?.scrollLeft ?? 0,
                                  scrollY: mapRef.current?.scrollTop ?? 0,
                                  moved: false,
                                };
                              }}
                              onPointerMove={(event) => {
                                const drag = nodeDrag.current;
                                if (!drag || drag.id !== node.id) return;
                                const dx = event.clientX - drag.x,
                                  dy = event.clientY - drag.y;
                                if (Math.hypot(dx, dy) > 4) drag.moved = true;
                                if (!drag.moved) return;
                                setNodePreview({
                                  id: node.id,
                                  x: Math.max(
                                    0,
                                    Math.min(
                                      12000,
                                      drag.left +
                                        (dx + (mapRef.current?.scrollLeft ?? 0) - drag.scrollX) /
                                          zoom,
                                    ),
                                  ),
                                  y: Math.max(
                                    0,
                                    Math.min(
                                      12000,
                                      drag.top +
                                        (dy + (mapRef.current?.scrollTop ?? 0) - drag.scrollY) /
                                          zoom,
                                    ),
                                  ),
                                });
                              }}
                              onPointerUp={() => finishNodeDrag(true)}
                              onPointerCancel={() => finishNodeDrag(false)}
                              onLostPointerCapture={() => finishNodeDrag(false)}
                              onClick={() => {
                                if (suppressNodeClick.current === node.id) {
                                  suppressNodeClick.current = null;
                                  return;
                                }
                                select(node);
                              }}
                              onKeyDown={(e) => {
                                if (
                                  ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(
                                    e.key,
                                  )
                                ) {
                                  e.preventDefault();
                                  if (e.shiftKey) {
                                    const steps: Record<string, [number, number]> = {
                                      ArrowLeft: [-20, 0],
                                      ArrowRight: [20, 0],
                                      ArrowUp: [0, -20],
                                      ArrowDown: [0, 20],
                                    };
                                    const [x, y] = steps[e.key];
                                    updatePrefs({
                                      positions: {
                                        ...latestPrefs.current.positions,
                                        [node.id]: {
                                          x: Math.max(0, Math.min(12000, p.x + x)),
                                          y: Math.max(0, Math.min(12000, p.y + y)),
                                        },
                                      },
                                    });
                                    return;
                                  }
                                  const next =
                                    visible[
                                      (index +
                                        (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1) +
                                        visible.length) %
                                        visible.length
                                    ];
                                  select(next);
                                  document.getElementById(`node-${next.id}`)?.focus();
                                }
                              }}
                              id={`node-${node.id}`}
                              aria-label={`${node.label}, ${node.status}, ${node.provenance}, ${activity.label}`}
                            >
                              <small>
                                <span className="node-symbol" aria-hidden="true">
                                  {node.nativeChild
                                    ? '◈'
                                    : node.provenance === 'native'
                                      ? '✳'
                                      : '◉'}
                                </span>
                                {node.provenance === 'native'
                                  ? node.item?.kind
                                  : 'DERIVED TURN TASK'}
                              </small>
                              <strong>{node.label}</strong>
                              <span>
                                <i className={`status-dot ${activity.kind}`} aria-hidden="true" />
                                <span className="node-activity-label" title={activity.label}>
                                  {activity.label}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
                <div className="surface-foot">
                  <span>
                    {visible.length} tasks · {nodes.length - visible.length} hidden
                  </span>
                  <span>Solid: native parentage · Dashed: user assertion</span>
                </div>
              </section>
              <FloatingPanel
                title="Task inspector"
                badge={
                  (session.state.userInputs?.length ?? 0) +
                    (session.state.approvals?.length ?? 0) || undefined
                }
                layout={prefs.panels?.inspector}
                initial={{ x: window.innerWidth - 440, y: 150 }}
                onChange={(value) => panelChange('inspector', value)}
              >
                <section className="inspector" aria-label="Selected task inspector">
                  <div className="inspector-heading">
                    <p className="eyebrow">SELECTED TASK</p>
                    <h2 title={task?.label}>{task?.label ?? 'No tasks yet'}</h2>
                    <p className="muted">
                      {task?.provenance === 'native'
                        ? 'Native Muse item'
                        : 'Derived grouping by native turn ID'}{' '}
                      · {task?.status ?? 'idle'}
                    </p>
                    {task &&
                      queue.some(
                        (entry) =>
                          entry.target === task.id && ['review', 'failure'].includes(entry.kind),
                      ) && (
                        <div>
                          <button
                            onClick={() =>
                              updatePrefs({
                                acknowledgedTaskFacts: [
                                  ...new Set([
                                    ...(prefs.acknowledgedTaskFacts ?? []),
                                    taskAttentionKey(task),
                                  ]),
                                ],
                              })
                            }
                          >
                            {task.status === 'completed'
                              ? 'Mark completion inspected'
                              : task.status === 'cancelled' &&
                                  queue.some(
                                    (entry) => entry.target === task.id && entry.kind === 'review',
                                  )
                                ? 'Mark stop inspected'
                                : 'Mark failure seen'}
                          </button>
                          <details className="inspection-note">
                            <summary>About inspection</summary>
                            <p className="muted">
                              Inspection acknowledgement is presentation state. Verification and
                              acceptance use evidence.
                            </p>
                          </details>
                        </div>
                      )}
                    {task?.error && (
                      <section className="revision-badge stale" aria-label="Native task failure">
                        <strong>Muse error: {task.error.kind}</strong>
                        <span>{task.error.message}</span>
                        {task.error.kind === 'authRequired' && (
                          <p>
                            Sign in with <code>muse login</code> or configure a provider API key
                            locally, then start a new turn. The failed turn is retained for
                            inspection.
                          </p>
                        )}
                      </section>
                    )}
                  </div>
                  {task?.provenance === 'native' &&
                    nodes.some((node) => node.id === session.id + ':' + task.turnId) && (
                      <button
                        onClick={() =>
                          select(nodes.find((node) => node.id === session.id + ':' + task.turnId)!)
                        }
                      >
                        Open owning turn
                      </button>
                    )}
                  <button
                    className="session-settings-trigger"
                    disabled={
                      !available ||
                      busy ||
                      task?.provenance === 'native' ||
                      !status.features?.includes('sessionSettings')
                    }
                    onClick={async () => {
                      const token = crypto.randomUUID();
                      settingsRequest.current = token;
                      setSettingsTarget(session.id);
                      setSettingsCatalog(null);
                      setSettingsMessage('');
                      setModal('settings');
                      try {
                        const catalog = await request('models', { sessionId: session.id });
                        if (settingsRequest.current === token) setSettingsCatalog(catalog);
                      } catch (error) {
                        if (settingsRequest.current === token) setSettingsMessage(String(error));
                      }
                    }}
                  >
                    Session model &amp; effort
                  </button>
                  {status.features?.includes('localRelay') && (
                    <button className="session-settings-trigger" onClick={() => setModal('relay')}>
                      Connect sessions
                    </button>
                  )}
                  <div className="tabs" role="tablist">
                    {inspectorTabs.map((name) => (
                      <button
                        key={name}
                        id={`tab-${name}`}
                        aria-controls="inspector-panel"
                        role="tab"
                        aria-selected={tab === name}
                        tabIndex={tab === name ? 0 : -1}
                        onKeyDown={(event) => {
                          const names = inspectorTabs;
                          const index = names.indexOf(name);
                          const target =
                            event.key === 'ArrowRight'
                              ? names[(index + 1) % names.length]
                              : event.key === 'ArrowLeft'
                                ? names[(index + names.length - 1) % names.length]
                                : event.key === 'Home'
                                  ? names[0]
                                  : event.key === 'End'
                                    ? names[names.length - 1]
                                    : undefined;
                          if (target) {
                            event.preventDefault();
                            setTab(target);
                            document.getElementById(`tab-${target}`)?.focus();
                          }
                        }}
                        onClick={() => setTab(name)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <div
                    className="inspector-body"
                    id="inspector-panel"
                    role="tabpanel"
                    aria-labelledby={`tab-${tab}`}
                  >
                    {tab === 'workspace' && (
                      <Workspace
                        key={session.id}
                        session={session}
                        commands={status.commands}
                        busy={busy}
                        mutate={mutate}
                        attach={(value) => {
                          if ((drafts[session.id] ?? '').length + value.length > 16000) {
                            setError(
                              'File content exceeds the task draft limit. Choose a smaller file or provide its path.',
                            );
                            return;
                          }
                          setDrafts((previous) => ({
                            ...previous,
                            [session.id]: (previous[session.id] ?? '') + value,
                          }));
                          setTab('transcript');
                          setNotice(
                            'File content added to the task draft. Review it before sending.',
                          );
                        }}
                      />
                    )}
                    {tab === 'transcript' && (
                      <>
                        {task?.nativeChild && (
                          <section className="decision">
                            <h3>Native workflow child</h3>
                            <pre>{text(task.nativeChild)}</pre>
                            <p className="muted">
                              The runtime supplies this child's identity, attempt, outcome and
                              result reference. It does not supply a child-session transcript ID on
                              this workflow envelope.
                            </p>
                          </section>
                        )}
                        <DecisionPanels
                          session={session}
                          disabled={!available || busy}
                          mutate={mutate}
                        />
                        <div className="transcript-tools">
                          <span>
                            {transcriptItems.length} shown ·{' '}
                            {history !== null ? total : session.state.totalItems} in session
                          </span>
                          <button disabled={!available || busy} onClick={() => void page()}>
                            {history !== null
                              ? offset
                                ? 'Next page'
                                : 'Back to first page'
                              : 'Browse history'}
                          </button>
                        </div>
                        <label className="transcript-background">
                          <input
                            type="checkbox"
                            checked={prefs.showRuntimeReminders ?? false}
                            onChange={(event) =>
                              updatePrefs({ showRuntimeReminders: event.target.checked })
                            }
                          />
                          Background activity
                          {items.length !== transcriptItems.length
                            ? ` (${items.length - transcriptItems.length} hidden)`
                            : ''}
                        </label>
                        {transcriptItems.map((item) => (
                          <article
                            key={item.itemId}
                            className="transcript-item"
                            data-kind={item.kind}
                          >
                            <header>
                              <strong>
                                {item.tool ??
                                  itemLabels[item.kind] ??
                                  item.kind ??
                                  'Native activity'}
                              </strong>
                              <small>
                                {item.status === 'completed'
                                  ? item.kind === 'userMessage'
                                    ? 'Sent'
                                    : 'Complete'
                                  : (itemStatusLabels[item.status] ?? item.status)}
                              </small>
                            </header>
                            <pre>
                              {(item.status === 'inProgress'
                                ? session.state.provisionalText?.[item.itemId]
                                : undefined) ??
                                (item.kind === 'skillRead'
                                  ? `${item.selector ?? 'Skill'} · ${item.status === 'completed' ? 'loaded' : item.status === 'inProgress' ? 'loading' : (itemStatusLabels[item.status] ?? item.status)}`
                                  : undefined) ??
                                item.displayText ??
                                item.text ??
                                item.objective ??
                                item.fallbackText ??
                                item.finalSummary ??
                                (item.kind === 'toolCall'
                                  ? (item.statusLine ?? 'Tool execution')
                                  : text(item))}
                            </pre>
                            {item.kind === 'userMessage' && (item.attachments?.length ?? 0) > 0 && (
                              <small className="transcript-attachments">
                                {item.attachments?.length === 1
                                  ? '1 image attached'
                                  : `${item.attachments?.length} images attached`}
                              </small>
                            )}
                            <details>
                              <summary>Message details</summary>
                              <small>
                                Revision {item.revision} · {item.itemId} ·{' '}
                                {item.recordedAt ?? 'Time not reported'}
                              </small>
                              {item.kind === 'skillRead' && <pre>{text(item)}</pre>}
                              <pre>
                                {text(
                                  session.state.itemProvenance?.[item.itemId] ??
                                    'Source cursor and event range unavailable',
                                )}
                              </pre>
                            </details>
                            {item.kind === 'workflow' && item.finalSummary && (
                              <section
                                className="revision-badge"
                                aria-label="Native workflow outcome"
                              >
                                <strong>Native workflow outcome</strong>
                                <pre>{workflowSummary(item.finalSummary)}</pre>
                                <small>
                                  This is a returned summary, not independently verified evidence.
                                </small>
                              </section>
                            )}
                            {item.args && (
                              <details>
                                <summary>Arguments</summary>
                                <pre>{item.args}</pre>
                              </details>
                            )}
                            {(item.outputRef || item.patchRef) && (
                              <StoredOutput
                                key={`${session.id}:${item.itemId}:${item.revision}`}
                                sessionId={session.id}
                                item={item}
                                disabled={!available || busy || !!task?.childSessionId}
                              />
                            )}
                            {item.visibleOutput && (
                              <details open>
                                <summary>Tool output</summary>
                                <pre>{item.visibleOutput}</pre>
                              </details>
                            )}
                          </article>
                        ))}
                        {items.length === 0 && (
                          <p className="muted">Send a task to begin its transcript.</p>
                        )}
                      </>
                    )}
                    {tab === 'diff' && (
                      <section className="diff-review" aria-label="Saved changes">
                        {session.projectContext && (
                          <p className="muted">
                            Project snapshots need a repository picker. Combined snapshots are
                            unavailable; inspect changes in each repository directly.
                          </p>
                        )}
                        <div className="diff-toolbar">
                          <button
                            className="primary"
                            disabled={
                              !available || busy || !task?.turnId || !!session.projectContext
                            }
                            onClick={() => void capture()}
                          >
                            Save snapshot
                          </button>
                          <button
                            aria-label="Refresh saved snapshots"
                            onClick={() => void loadReview()}
                          >
                            Refresh
                          </button>
                        </div>
                        <details className="snapshot-help">
                          <summary>About snapshots</summary>
                          <p>
                            A snapshot saves the current Git commit, changed files and new files for
                            review. Linking it to a task is your choice; it does not prove which
                            task made the changes.
                          </p>
                        </details>
                        <label>
                          Saved snapshot
                          <select
                            value={candidate?.id ?? ''}
                            onChange={(e) => setArtifactId(e.target.value)}
                          >
                            <option value="">Choose a snapshot</option>
                            {review.artifacts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {short(a.fingerprint.slice(7))} ·{' '}
                                {new Date(a.capturedAtMillis).toLocaleTimeString()}
                              </option>
                            ))}
                          </select>
                        </label>
                        {artifact ? (
                          <>
                            <RevisionBadge artifact={artifact} fresh={fresh} />
                            <DiffView key={artifact.id} patch={artifact.patch} />
                            {artifact.untracked.map((f) => (
                              <details key={f.path} open>
                                <summary>
                                  Untracked: {f.path} · {f.bytes} bytes
                                </summary>
                                <pre>{f.text ?? `Binary file · ${f.sha256}`}</pre>
                              </details>
                            ))}
                          </>
                        ) : (
                          <p className="muted">Save a snapshot to review the current changes.</p>
                        )}
                      </section>
                    )}
                    {tab === 'evidence' && (
                      <>
                        {artifact ? (
                          <>
                            <RevisionBadge artifact={artifact} fresh={fresh} />
                            <p className="muted">
                              Completion, test results, review and acceptance are distinct. Records
                              below are explicit user attestations with a native source item, not
                              automatic verification.
                            </p>
                            <EvidenceForm
                              key={artifact.id}
                              artifact={artifact}
                              items={status.sessions
                                .filter((s) => s.workspace === session.workspace)
                                .flatMap((s) =>
                                  (s.state.items ?? []).map((item) => ({
                                    ...item,
                                    sourceSessionId: s.id,
                                  })),
                                )}
                              disabled={!available || busy || fresh?.fresh !== true}
                              record={async (params) => {
                                await mutate('evidence/record', {
                                  ...params,
                                  sessionId: session.id,
                                  artifactId: artifact.id,
                                  fingerprint: artifact.fingerprint,
                                });
                                await loadReview();
                              }}
                            />
                            {review.nextOffset != null && (
                              <button
                                onClick={async () => {
                                  const value = await request('review/list', {
                                    sessionId: session.id,
                                    artifactId: artifact.id,
                                    offset: review.nextOffset,
                                  });
                                  if (
                                    selectedSession.current === session.id &&
                                    selectedTask.current === task?.id
                                  )
                                    setReview(value);
                                }}
                              >
                                Older evidence records
                              </button>
                            )}
                            {review.evidence
                              .filter((e) => e.artifactId === artifact.id)
                              .map((e) => (
                                <article className="evidence-card" key={e.id}>
                                  <strong>
                                    {e.params.kind}: {e.params.outcome}
                                  </strong>
                                  <span>
                                    {e.provenance === 'userAttested'
                                      ? 'User attestation; revision association unverified'
                                      : e.provenance}{' '}
                                    ·{' '}
                                    {fresh?.fresh === true
                                      ? 'current revision'
                                      : fresh?.fresh === false
                                        ? 'stale revision'
                                        : 'freshness unknown'}
                                  </span>
                                  <p>{e.params.notes}</p>
                                  <code>
                                    {e.params.command} · exit{' '}
                                    {e.params.exitCode ?? 'not applicable'}
                                  </code>
                                  <small>
                                    {e.params.author} · {e.params.environment} · source r
                                    {e.source.revision}
                                  </small>
                                </article>
                              ))}
                          </>
                        ) : (
                          <p className="muted">
                            Capture and inspect a diff before recording revision-bound evidence.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  {task && (
                    <details className="layout-controls">
                      <summary>Task label, notes and relationships</summary>
                      {!status.features?.includes('sessionNames') && (
                        <label>
                          Session display label
                          <input
                            value={prefs.sessionLabels?.[session.id] ?? ''}
                            maxLength={100}
                            onChange={(event) =>
                              updatePrefs({
                                sessionLabels: {
                                  ...prefs.sessionLabels,
                                  [session.id]: event.target.value,
                                },
                              })
                            }
                          />
                        </label>
                      )}
                      <label>
                        Task label
                        <input
                          key={task.id + 'label'}
                          value={prefs.labels?.[task.id] ?? task.label}
                          onChange={(e) =>
                            updatePrefs({
                              labels: {
                                ...prefs.labels,
                                [task.id]: e.target.value.slice(0, 200),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        Annotation
                        <textarea
                          key={task.id + 'annotation'}
                          value={prefs.annotations?.[task.id] ?? ''}
                          onChange={(e) =>
                            updatePrefs({
                              annotations: {
                                ...prefs.annotations,
                                [task.id]: e.target.value.slice(0, 2000),
                              },
                            })
                          }
                        />
                      </label>
                      <div className="row">
                        <button
                          onClick={() => {
                            const p = position(
                              task,
                              visible.findIndex((n) => n.id === task.id),
                            );
                            updatePrefs({
                              positions: {
                                ...prefs.positions,
                                [task.id]: { x: p.x + 20, y: p.y },
                              },
                            });
                          }}
                        >
                          Pin / move right
                        </button>
                        <button
                          onClick={() => {
                            const p = position(
                              task,
                              visible.findIndex((n) => n.id === task.id),
                            );
                            updatePrefs({
                              positions: {
                                ...prefs.positions,
                                [task.id]: { x: p.x, y: p.y + 20 },
                              },
                            });
                          }}
                        >
                          Move down
                        </button>
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const data = new FormData(e.currentTarget);
                          updatePrefs({
                            edges: [
                              ...(prefs.edges ?? []),
                              {
                                id: crypto.randomUUID(),
                                from: task.id,
                                to: String(data.get('target')),
                                kind: String(data.get('kind')),
                                provenance: 'userAsserted',
                                revision: 1,
                              },
                            ],
                          });
                        }}
                      >
                        <label>
                          Relationship
                          <select name="kind">
                            <option>depends on</option>
                            <option>handed off to</option>
                          </select>
                        </label>
                        <label>
                          Target task
                          <select name="target">
                            {status.sessions
                              .flatMap((s) => tasks(s, prefs))
                              .filter((n) => n.id !== task.id)
                              .map((n) => (
                                <option key={n.id} value={n.id}>
                                  {n.label}
                                </option>
                              ))}
                          </select>
                        </label>
                        <button
                          disabled={status.sessions.flatMap((s) => tasks(s, prefs)).length < 2}
                        >
                          Record user assertion
                        </button>
                      </form>
                      <ul>
                        {prefs.edges
                          ?.filter((e) => e.from === task.id)
                          .map((e) => (
                            <li key={e.id}>
                              {e.kind}{' '}
                              {status.sessions
                                .flatMap((s) => tasks(s, prefs))
                                .find((n) => n.id === e.to)?.label ?? e.to}{' '}
                              · user asserted r{e.revision}
                              <button
                                onClick={() =>
                                  updatePrefs({
                                    edges: prefs.edges?.filter((v) => v.id !== e.id),
                                  })
                                }
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                      </ul>
                    </details>
                  )}
                  <div className="command-area">
                    <details>
                      <summary>Runtime and interruption history</summary>
                      <pre>
                        {text({
                          generation: session.generation,
                          lifecycle: session.lifecycle,
                          handshake: session.handshake,
                          interruptions: session.interruptions,
                        })}
                      </pre>
                      {session.interruptions?.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            updatePrefs({
                              acknowledgedInterruptions: [
                                ...new Set([
                                  ...(prefs.acknowledgedInterruptions ?? []),
                                  ...session.interruptions.map(
                                    (i) => session.id + ':interrupt:' + i.atMillis + ':' + i.kind,
                                  ),
                                ]),
                              ],
                            })
                          }
                        >
                          Mark interruptions seen
                        </button>
                      )}
                    </details>
                    <form
                      onDragOver={(event) => {
                        if (
                          status.features?.includes('attachments') &&
                          event.dataTransfer.types.includes('Files')
                        )
                          event.preventDefault();
                      }}
                      onDrop={(event) => {
                        if (!status.features?.includes('attachments')) return;
                        const files = [...event.dataTransfer.files];
                        if (!files.length) return;
                        event.preventDefault();
                        setImageDrop({ files, at: Date.now() });
                      }}
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        const message = String(data.get('message'));
                        if (message.trim() === '/usage') {
                          setModal('usage');
                          return;
                        }
                        if (draftConflicts[session.id]) return;
                        const projectRevision = session.state.activeTurnId
                          ? undefined
                          : projectChoice[session.id];
                        const attachments = session.state.activeTurnId
                          ? []
                          : (images[session.id]?.ready ?? []);
                        const result = await mutate(session.state.activeTurnId ? 'steer' : 'turn', {
                          sessionId: session.id,
                          text: message,
                          ...(session.state.activeTurnId
                            ? { turnId: session.state.activeTurnId }
                            : {}),
                          ...(projectRevision !== undefined ? { projectRevision } : {}),
                          ...(attachments.length ? { attachments } : {}),
                        });
                        if (result && ['applied', 'accepted'].includes(result.status)) {
                          setDrafts((previous) => ({ ...previous, [session.id]: '' }));
                          if (projectRevision !== undefined)
                            setProjectChoice((previous) => ({
                              ...previous,
                              [session.id]: undefined,
                            }));
                          if (attachments.length)
                            setImageEpoch((previous) => ({
                              ...previous,
                              [session.id]: (previous[session.id] ?? 0) + 1,
                            }));
                        }
                      }}
                    >
                      {status.features?.includes('skills') && (
                        <SkillPicker
                          key={`skills:${session.id}`}
                          sessionId={session.id}
                          text={drafts[session.id] ?? ''}
                          select={(text) =>
                            setDrafts((previous) => ({ ...previous, [session.id]: text }))
                          }
                          openUsage={() => setModal('usage')}
                        />
                      )}
                      {session.projectContext &&
                        status.features?.includes('projectContextUpdates') && (
                          <ProjectUpdate
                            key={`project-update:${session.id}`}
                            session={session}
                            busy={busy}
                            chosen={projectChoice[session.id]}
                            choose={(revision) =>
                              setProjectChoice((previous) => ({
                                ...previous,
                                [session.id]: revision,
                              }))
                            }
                          />
                        )}
                      <label htmlFor="message">
                        {session.state.activeTurnId
                          ? 'Steer current turn'
                          : 'New task for this session'}
                      </label>
                      <textarea
                        id="message"
                        name="message"
                        value={drafts[session.id] ?? ''}
                        onChange={(event) =>
                          setDrafts((previous) => ({
                            ...previous,
                            [session.id]: event.target.value,
                          }))
                        }
                        required
                        maxLength={16000}
                        placeholder="Describe the next step…"
                        disabled={!available || busy || task?.provenance === 'native'}
                        onPaste={(event) => {
                          if (!status.features?.includes('attachments')) return;
                          const files = [...event.clipboardData.files].filter((f) =>
                            f.type.startsWith('image/'),
                          );
                          if (!files.length) return;
                          event.preventDefault();
                          setImageDrop({ files, at: Date.now() });
                        }}
                      />
                      {status.features?.includes('attachments') && (
                        <ComposerImages
                          key={`images:${session.id}:${imageEpoch[session.id] ?? 0}`}
                          sessionId={session.id}
                          disabled={!available || busy}
                          steering={Boolean(session.state.activeTurnId)}
                          addRequest={imageDrop}
                          onChange={(ready, preparing) =>
                            setImages((previous) => ({
                              ...previous,
                              [session.id]: { ready, preparing },
                            }))
                          }
                        />
                      )}
                      {draftConflicts[session.id] && (
                        <DraftConflict
                          key={`draft-conflict:${session.id}`}
                          focusRequested={draftToReview === session.id}
                          onFocused={() => setDraftToReview(undefined)}
                          local={drafts[session.id] ?? ''}
                          saved={draftConflicts[session.id].text}
                          resolve={(choice) => resolveConflict(session.id, choice)}
                        />
                      )}
                      <div className="row">
                        <span className="muted session-target">
                          Target session: {sessionName(session)} · {short(session.id)}
                          {session.state.activeTurnId
                            ? ' · turn ' + short(session.state.activeTurnId)
                            : ''}
                          {task?.childSessionId ? ' · child is read-only' : ''}
                        </span>
                        <button
                          className="primary"
                          disabled={
                            !available ||
                            busy ||
                            task?.provenance === 'native' ||
                            Boolean(draftConflicts[session.id]) ||
                            Boolean(images[session.id]?.preparing)
                          }
                        >
                          {session.state.activeTurnId ? 'Send steering' : 'Start turn'}
                        </button>
                        {session.state.activeTurnId && (
                          <button
                            type="button"
                            disabled={!available || busy || task?.provenance === 'native'}
                            onClick={() =>
                              void mutate('cancel', {
                                sessionId: session.id,
                                turnId: session.state.activeTurnId,
                              })
                            }
                          >
                            Cancel turn
                          </button>
                        )}
                      </div>
                    </form>
                    <details>
                      <summary>Command acknowledgements</summary>
                      {status.commands
                        .filter((c) => c.sessionId === session.id)
                        .slice(0, 10)
                        .map((c) => (
                          <div key={c.id}>
                            <strong>
                              {c.operation}: {c.status}
                            </strong>
                            <small>Request {c.id}</small>
                            {c.error && <pre>{text(c.error)}</pre>}
                          </div>
                        ))}
                      {lastCommand.current && (
                        <button
                          disabled={busy}
                          onClick={async () => {
                            const last = lastCommand.current!;
                            setBusy(true);
                            try {
                              const r = await request(last.operation, last.params, last.id);
                              setNotice(
                                `${last.operation}: ${r.status ?? 'saved'} · same request ID`,
                              );
                              await refresh();
                            } catch (e) {
                              setError(String(e));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Query / retry last request with same ID
                        </button>
                      )}
                    </details>
                  </div>
                </section>
              </FloatingPanel>
            </div>
          </>
        )}
      </main>
      {session && prefs.panels?.connections && status.features?.includes('relayMap') && (
        <FloatingPanel
          title="Session links"
          layout={prefs.panels.connections}
          initial={{ x: 320, y: 160 }}
          onChange={(value) => panelChange('connections', value)}
        >
          <SessionConnections
            connected={connected}
            session={session}
            sessions={status.sessions}
            connections={status.relayConnections ?? []}
            unread={status.relayUnread ?? []}
            name={sessionName}
            onOpen={(peer) => {
              setRelayTarget(peer ? { source: session.id, peer } : undefined);
              setModal('relay');
            }}
          />
        </FloatingPanel>
      )}
      <dialog ref={modalRef} onCancel={() => setModal(null)} aria-labelledby="dialog-heading">
        <div className="dialog-heading">
          <h2 id="dialog-heading">
            {modal === 'rename'
              ? 'Rename session'
              : modal === 'inbox'
                ? 'New local messages'
                : modal === 'help'
                  ? 'Lascoria help'
                  : modal === 'data'
                    ? 'Data and backups'
                    : modal === 'search'
                      ? 'Search history'
                      : modal === 'relay'
                        ? 'Local session messages'
                        : modal === 'usage'
                          ? 'Muse usage'
                          : modal === 'account'
                            ? 'Your Muse connection'
                            : modal === 'start'
                              ? 'Start a Muse session'
                              : modal === 'stop'
                                ? 'Log out of Lascoria'
                                : modal === 'diagnostics'
                                  ? 'Performance diagnostics'
                                  : modal === 'settings'
                                    ? 'Session model and effort'
                                    : 'Command palette'}
          </h2>
          <button onClick={() => setModal(null)} aria-label="Close dialog">
            ×
          </button>
        </div>
        {modal === 'rename' && session && (
          <RenameSession
            key={session.id}
            session={session}
            initialName={session.displayName ?? prefs.sessionLabels?.[session.id] ?? ''}
            refresh={refresh}
            close={() => setModal(null)}
          />
        )}
        {modal === 'help' && (
          <Help
            navigate={setModal}
            available={{
              account: Boolean(status.features?.includes('accounts')),
              start: connected,
              usage: Boolean(session && status.features?.includes('usage')),
              relay: Boolean(session && status.features?.includes('localRelay')),
            }}
          />
        )}
        {modal === 'search' && (
          <HistorySearch
            sessions={status.sessions}
            name={sessionName}
            open={(sessionId) => {
              if (status.sessions.find((s) => s.id === sessionId)?.lifecycle === 'archived')
                setShowArchived(true);
              updatePrefs({ sessionId, selection: undefined });
              setTab('transcript');
              setModal(null);
            }}
          />
        )}
        {modal === 'data' && (
          <DataLifecycle refreshStatus={refresh} quit={() => setModal('stop')} />
        )}
        {modal === 'inbox' && (
          <section className="message-discovery-list" aria-label="Conversations with new messages">
            <p>
              Choose a conversation to review. Opening it does not mark messages viewed or send them
              to Muse.
            </p>
            {newMessages.length === 0 && <p className="muted">All caught up.</p>}
            {newMessages.map((entry) => {
              const recipient = status.sessions.find((row) => row.id === entry.sessionId)!;
              const sender = status.sessions.find((row) => row.id === entry.peerId);
              return (
                <button
                  key={`${entry.sessionId}:${entry.peerId}`}
                  onClick={() => {
                    updatePrefs({ sessionId: entry.sessionId, selection: undefined });
                    setRelayTarget({ source: entry.sessionId, peer: entry.peerId });
                    setModal('relay');
                  }}
                >
                  <strong>
                    {sessionName(recipient)} <small>· {short(recipient.id)}</small>
                  </strong>
                  <span>
                    From {sender ? sessionName(sender) : `Session ${short(entry.peerId)}`} ·{' '}
                    {short(entry.peerId)}
                  </span>
                  <span>
                    {entry.count} new {entry.count === 1 ? 'message' : 'messages'}
                    {recipient.lifecycle === 'archived' ? ' · Archived session' : ''}
                  </span>
                </button>
              );
            })}
          </section>
        )}
        {modal === 'relay' && session && (
          <SessionRelay
            key={session.id}
            session={session}
            sessions={status.sessions}
            labels={Object.fromEntries(status.sessions.map((row) => [row.id, sessionName(row)]))}
            draftStore={relayDrafts}
            draftsEnabled={Boolean(status.features?.includes('relayDrafts'))}
            viewsEnabled={Boolean(status.features?.includes('relayViews'))}
            initialPeer={relayTarget?.source === session.id ? relayTarget.peer : undefined}
          />
        )}
        {modal === 'usage' && (
          <Usage
            key={`${session?.id}:${account?.mode}:${account?.subscription.state}`}
            sessionId={session?.id}
          />
        )}
        {modal === 'account' && (
          <Account account={account} refresh={refreshAccount} onRuntimeReady={setRuntimeReady} />
        )}
        {modal === 'settings' &&
          (() => {
            const target = status.sessions.find((s) => s.id === settingsTarget);
            const ready = target?.state.current && target.lifecycle === 'connected' && !busy;
            const model = target?.state.modelRoute?.modelId;
            const effort = target?.state.reasoningEffort;
            const apply = async (operation: string, params: Json) => {
              const result = await mutate(operation, { sessionId: settingsTarget, ...params });
              setSettingsMessage(
                !result
                  ? 'Request outcome unknown; inspect the journal before retrying.'
                  : result.status === 'rejected'
                    ? (result.error?.message ?? 'Muse refused this setting.')
                    : result.status === 'outcomeUnknown'
                      ? 'Outcome unknown; inspect the journal before retrying.'
                      : operation === 'setModel'
                        ? 'Model change admitted. It takes effect at the next model-call boundary.'
                        : 'Effort default saved for subsequent turns. The running turn keeps its resolved effort.',
              );
            };
            return (
              <>
                <p className="settings-summary">
                  {target ? sessionName(target) : 'Session'} · {short(settingsTarget)}{' '}
                  <span>·</span> {model ?? 'Provider model'} <span>·</span>{' '}
                  {effort ? `${effort} effort` : 'Model default effort'}
                </p>
                {settingsMessage && <p role="status">{settingsMessage}</p>}
                {!settingsCatalog ? (
                  !settingsMessage && <p>Loading available models...</p>
                ) : (
                  <SessionSettings
                    key={settingsTarget}
                    catalog={settingsCatalog}
                    model={model}
                    effort={effort}
                    ready={!!ready}
                    apply={apply}
                  />
                )}
              </>
            );
          })()}
        {modal === 'diagnostics' && (
          <>
            <p className="muted">
              Bounded process-local timings. Navigation measures React commit, not display paint.
              IPC includes transport and queue time. SDK RSS excludes Muse; sessions sharing a
              process ID share that memory.
            </p>
            <label>
              Diagnostic report
              <textarea readOnly rows={18} value={diagnosticReport} />
            </label>
          </>
        )}
        {modal === 'start' && account?.managed && !account.authenticated && (
          <p role="alert">Sign in from Muse account before starting a session.</p>
        )}
        {modal === 'start' && status.features?.includes('projects') && (
          <div className="segmented" role="group" aria-label="Start type">
            <button aria-pressed={startKind === 'session'} onClick={() => setStartKind('session')}>
              Session
            </button>
            <button aria-pressed={startKind === 'project'} onClick={() => setStartKind('project')}>
              Project
            </button>
          </div>
        )}
        {modal === 'start' && startKind === 'project' && status.features?.includes('projects') && (
          <ProjectStart
            disabled={!runtimeReady || !!(account?.managed && !account.authenticated)}
            started={(sessionId) => {
              updatePrefs({ sessionId, selection: undefined });
              setModal(null);
              void refresh();
            }}
          />
        )}
        {modal === 'start' &&
          (startKind === 'session' || !status.features?.includes('projects')) && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (folderPicking) return;
                const form = new FormData(e.currentTarget);
                const modelId = String(form.get('model') ?? '');
                const result = await mutate('start', {
                  workspace: String(form.get('workspace')),
                  ...(status.features?.includes('sessionNames')
                    ? { name: String(form.get('sessionName') ?? '') }
                    : {}),
                  isolated: form.get('isolated') === 'on',
                  ...(modelId ? { modelId } : {}),
                });
                if (result && result.status === 'applied') {
                  updatePrefs({ sessionId: result.sessionId, selection: undefined });
                  setModal(null);
                  const message = String(form.get('initial'));
                  if (message) await mutate('turn', { sessionId: result.sessionId, text: message });
                }
              }}
            >
              {status.features?.includes('sessionNames') && (
                <label>
                  Session name (optional)
                  <input name="sessionName" maxLength={100} placeholder="Use the folder name" />
                </label>
              )}
              <FolderPath
                label="Existing repository path"
                browseLabel="Browse for repository"
                name="workspace"
                value={startFolder}
                onChange={setStartFolder}
                disabled={busy}
                onPicking={setFolderPicking}
              />
              <label className="row">
                <input
                  type="checkbox"
                  name="isolated"
                  defaultChecked={status.features?.includes('taskWorkspaces')}
                  disabled={!status.features?.includes('taskWorkspaces')}
                />{' '}
                Create an isolated task worktree from committed HEAD
              </label>
              <p className="muted">
                {status.features?.includes('taskWorkspaces')
                  ? 'The isolated task starts from committed files. Existing uncommitted changes stay in the original checkout.'
                  : 'This supervisor does not support isolated tasks. Restart it to enable them; this session will use the existing checkout directly.'}
              </p>
              <label htmlFor="session-model">Model</label>
              <select
                id="session-model"
                name="model"
                defaultValue=""
                disabled={!status.features?.includes('modelSelection')}
              >
                <option value="">Muse catalog default</option>
                <option value="muse-wonder-1.0">Muse Wonder 1.0</option>
                <option value="muse-spark-1.3">Muse Spark 1.3</option>
              </select>
              {!status.features?.includes('modelSelection') && (
                <p className="muted">
                  This supervisor predates model selection. Restart it to enable explicit model
                  choices; existing sessions keep their routes.
                </p>
              )}
              <label>
                Initial task
                <textarea
                  name="initial"
                  required
                  maxLength={16000}
                  placeholder="What should Muse work on?"
                />
              </label>
              <p className="muted">
                The default follows Muse's catalog. Explicit models require provider access;
                failures remain visible. Model selection applies to this new session. Muse controls
                tool permissions. Closing this window leaves the supervisor and sessions running.
              </p>
              <button
                className="primary"
                disabled={
                  busy ||
                  folderPicking ||
                  !runtimeReady ||
                  (account?.managed && !account.authenticated)
                }
              >
                Start session
              </button>
            </form>
          )}
        {modal === 'stop' && (
          <ExitDialog
            sessions={status.sessions}
            account={account ?? undefined}
            name={sessionName}
            closeBehavior={prefs.closeBehavior}
            busy={busy}
            onExit={(choice, remember) => void exitLascoria(choice, remember)}
            onCancel={() => setModal(null)}
          />
        )}
        {modal === 'palette' && (
          <>
            <button
              disabled={!session || !status.features?.includes('usage')}
              onClick={() => setModal('usage')}
            >
              /usage · Muse subscription usage
            </button>
            <button
              onClick={() => {
                setModal('start');
              }}
            >
              Start a new session
            </button>
            <button
              onClick={() => {
                setModal(null);
                updatePrefs({ view: 'list' });
              }}
            >
              Show task list
            </button>
            <button
              onClick={() => {
                setModal(null);
                setTab('diff');
              }}
            >
              Inspect selected diff
            </button>
            {status.sessions
              .flatMap((s) => tasks(s, prefs))
              .map((node) => (
                <button
                  key={node.id}
                  onClick={() => {
                    select(node);
                    setModal(null);
                  }}
                >
                  {node.label} · {short(node.sessionId)}
                </button>
              ))}
          </>
        )}
      </dialog>
    </div>
  );
}
function StoredOutput({
  sessionId,
  item,
  disabled,
}: {
  sessionId: string;
  item: Item;
  disabled: boolean;
}) {
  const [page, setPage] = useState<Json>(),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const ref = (item.patchRef ?? item.outputRef)!;
  async function read(offsetBytes: number) {
    setPending(true);
    try {
      setPage(
        await request('output', {
          sessionId,
          itemId: item.itemId,
          revision: item.revision,
          outputRef: ref.id,
          offsetBytes,
        }),
      );
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <details>
      <summary>Stored {item.patchRef ? 'native patch' : 'full output'}</summary>
      <p className="muted">
        {ref.mediaType} · {ref.byteLen} bytes
      </p>
      <button
        disabled={disabled || pending}
        onClick={() => void read(page && !page.eof ? page.offsetBytes + page.byteLen : 0)}
      >
        {page && !page.eof ? 'Next output page' : 'Read first output page'}
      </button>
      {error && <p role="alert">{error}</p>}
      {page && (
        <pre>
          {page.encoding === 'utf8'
            ? page.content
            : `Binary page (${page.byteLen} bytes, base64): ${page.content}`}
        </pre>
      )}
    </details>
  );
}
function DiffView({ patch }: { patch: string }) {
  const [page, setPage] = useState(0);
  const lines = patch.split('\n');
  const size = 200;
  return (
    <section aria-label="Captured diff">
      <div className="row">
        <span className="muted">
          Lines {page * size + 1}–{Math.min((page + 1) * size, lines.length)} of {lines.length}
        </span>
        <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous diff page
        </button>
        <button disabled={(page + 1) * size >= lines.length} onClick={() => setPage((p) => p + 1)}>
          Next diff page
        </button>
      </div>
      <pre className="diff">
        {patch
          ? lines.slice(page * size, (page + 1) * size).map((line, index) => (
              <span
                className={
                  line.startsWith('+')
                    ? 'added'
                    : line.startsWith('-')
                      ? 'removed'
                      : line.startsWith('@@')
                        ? 'hunk'
                        : ''
                }
                key={index}
              >
                <i>{page * size + index + 1}</i>
                {line}
                {'\n'}
              </span>
            ))
          : 'No tracked changes in this capture.'}
      </pre>
    </section>
  );
}
function RevisionBadge({
  artifact,
  fresh,
}: {
  artifact: Artifact;
  fresh: { fresh: boolean; checkedAtMillis: number } | null;
}) {
  return (
    <div className={`revision-badge ${fresh?.fresh === false ? 'stale' : ''}`}>
      <strong>
        {fresh
          ? fresh.fresh
            ? 'Current captured content'
            : 'Stale: repository changed'
          : 'Freshness unknown'}
      </strong>
      <code>{artifact.fingerprint}</code>
      <small>
        Base / HEAD: {artifact.base} · task association: {artifact.provenance}
        {fresh ? ` · checked ${new Date(fresh.checkedAtMillis).toLocaleTimeString()}` : ''}
      </small>
    </div>
  );
}
function DecisionPanels({
  session,
  disabled,
  mutate,
}: {
  session: SessionRow;
  disabled: boolean;
  mutate: (operation: string, params: Json) => Promise<Json>;
}) {
  return (
    <>
      {(session.state.approvals ?? []).map((entry) => {
        const a = entry.requested;
        return (
          <section className="decision" key={a.approvalId}>
            <h3>Permission decision</h3>
            <p>Workspace: {session.workspace}</p>
            <p>
              <strong>{a.toolName}</strong> · {text(a.subject)}
            </p>
            <pre>{a.rawArgs}</pre>
            {a.subagentOrigin && <p>Delegated origin: {text(a.subagentOrigin)}</p>}
            <details>
              <summary>Request identity and provenance</summary>
              <pre>{text(a)}</pre>
            </details>
            <div className="row">
              {a.availableChoices.map((choice: Json) => (
                <button
                  key={choice.choiceId}
                  disabled={disabled}
                  onClick={() =>
                    void mutate('decide', {
                      sessionId: session.id,
                      approvalId: a.approvalId,
                      requirementId: a.currentRequirementId,
                      choiceId: choice.choiceId,
                    })
                  }
                >
                  {choice.label ?? choice.decision ?? choice.choiceId}
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {(session.state.userInputs ?? []).map((input) => (
        <form
          className="decision"
          key={input.userInputId}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void mutate('answer', {
              sessionId: session.id,
              userInputId: input.userInputId,
              answers: questionAnswers(input.questions, data),
            });
          }}
        >
          <h3>Muse needs an answer</h3>
          {input.questions.map((q: Json) => (
            <label key={q.id}>
              {q.question}
              {q.options?.length ? (
                <select
                  name={q.id}
                  multiple={q.selection?.mode === 'multiple'}
                  required
                  disabled={disabled}
                >
                  {q.options.map((o: Json) => (
                    <option key={o.label}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input name={q.id} required maxLength={500} disabled={disabled} />
              )}
            </label>
          ))}
          <button disabled={disabled}>Submit answer</button>
        </form>
      ))}
    </>
  );
}
function EvidenceForm({
  artifact,
  items,
  disabled,
  record,
}: {
  artifact: Artifact;
  items: Item[];
  disabled: boolean;
  record: (params: Json) => Promise<void>;
}) {
  const [kind, setKind] = useState('test');
  const sources = items.filter((i) => i.status !== 'inProgress');
  return (
    <form
      className="evidence-form"
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const source = sources.find((i) => i.itemId === data.get('source'));
        if (!source) return;
        await record({
          kind,
          outcome: String(data.get('outcome')),
          sourceItemId: source.itemId,
          sourceSessionId: source.sourceSessionId,
          sourceRevision: source.revision,
          author: String(data.get('author')),
          notes: String(data.get('notes')),
          command: String(data.get('command')),
          environment: String(data.get('environment')),
          exitCode: kind === 'test' ? Number(data.get('exit')) : null,
        });
      }}
    >
      <h3>Record evidence for {short(artifact.fingerprint.slice(7))}</h3>
      <label>
        Evidence type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="test">Test result</option>
          <option value="review">Review</option>
          <option value="acceptance">User acceptance</option>
        </select>
      </label>
      <label>
        Native source item
        <select name="source" required>
          {sources.map((i) => (
            <option key={i.itemId} value={i.itemId}>
              {i.tool ?? i.kind} · r{i.revision} · {short(i.itemId)} · session{' '}
              {short(i.sourceSessionId ?? '')}
            </option>
          ))}
        </select>
      </label>
      <label>
        Outcome
        <select key={kind} name="outcome">
          {(kind === 'test'
            ? ['passed', 'failed']
            : kind === 'review'
              ? ['approved', 'changesRequested']
              : ['accepted', 'rejected']
          ).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        {kind === 'review' ? 'Reviewer' : 'Attesting user'}
        <input name="author" required maxLength={200} />
      </label>
      <label>
        Command or review scope
        <input name="command" required maxLength={8000} />
      </label>
      {kind === 'test' && (
        <label>
          Observed exit code
          <input name="exit" type="number" required step="1" />
        </label>
      )}
      <label>
        Execution environment
        <input
          name="environment"
          required
          maxLength={8000}
          placeholder="macOS arm64, Node 24, local workspace"
        />
      </label>
      <label>
        Findings / result notes
        <textarea name="notes" required maxLength={8000} />
      </label>
      <button className="primary" disabled={disabled || sources.length === 0}>
        Save revision-bound attestation
      </button>
    </form>
  );
}
