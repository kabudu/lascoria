import { useEffect, useRef, useState } from 'react';
import { request } from './api';
type Draft = { text: string; revision: number; requestId?: string; expectedRevision?: number };
type DraftStore = { read: string; save: string; params: (id: string) => Record<string, string> };
const sessionStore: DraftStore = {
  read: 'drafts/get',
  save: 'drafts/save',
  params: (sessionId) => ({ sessionId }),
};
export const relayDraftStore: DraftStore = {
  read: 'relay/draftsGet',
  save: 'relay/draftSave',
  params: (id) => {
    const [sessionId, peerId] = id.split(':');
    return { sessionId, peerId };
  },
};
export function useDurableDrafts(
  enabled: boolean,
  report: (message: string) => void,
  store: DraftStore = sessionStore,
) {
  const [drafts, render] = useState<Record<string, string>>({});
  const [conflicts, renderConflicts] = useState<Record<string, Draft>>({});
  const conflictValues = useRef<Record<string, Draft>>({});
  function setConflict(id: string, draft?: Draft) {
    const next = { ...conflictValues.current };
    if (draft) next[id] = draft;
    else delete next[id];
    conflictValues.current = next;
    renderConflicts(next);
  }
  const values = useRef<Record<string, string>>({});
  const revisions = useRef<Record<string, number>>({});
  const savedValues = useRef<Record<string, Draft>>({});
  const dirty = useRef(new Set<string>());
  const loading = useRef<Promise<void> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const ready = useRef(false);
  const pending = useRef<Record<string, { id: string; text: string; expectedRevision: number }>>(
    {},
  );
  function load() {
    return (loading.current ??= request<{ drafts: Record<string, Draft> }>(store.read)
      .then((result) => {
        for (const [id, draft] of Object.entries(result.drafts)) {
          if (
            dirty.current.has(id) &&
            draft.revision !== (revisions.current[id] ?? 0) &&
            draft.text !== (values.current[id] ?? '')
          )
            setConflict(id, draft);
          savedValues.current[id] = draft;
          revisions.current[id] = draft.revision;
          if (!dirty.current.has(id)) values.current[id] = draft.text;
        }
        ready.current = true;
        render({ ...values.current });
      })
      .catch((error) => {
        loading.current = null;
        throw error;
      }));
  }
  function setDrafts(change: (previous: Record<string, string>) => Record<string, string>) {
    const next = change(values.current);
    for (const id of new Set([...Object.keys(values.current), ...Object.keys(next)]))
      if ((next[id] ?? '') !== (values.current[id] ?? '')) dirty.current.add(id);
    values.current = next;
    render(next);
  }
  function flushDrafts(): Promise<void> {
    if (!enabled)
      return dirty.current.size
        ? Promise.reject(new Error('Reconnect to save your draft before closing'))
        : Promise.resolve();
    if (saving.current) return saving.current;
    saving.current = (async () => {
      if (!ready.current) await load();
      while (dirty.current.size) {
        const ids = [...dirty.current].filter((id) => !conflictValues.current[id]).slice(0, 4);
        if (!ids.length) throw new Error('Choose which draft to keep before closing this window.');
        const results = await Promise.allSettled(
          ids.map(async (sessionId) => {
            const intent = (pending.current[sessionId] ??= {
              id: crypto.randomUUID(),
              text: values.current[sessionId] ?? '',
              expectedRevision: revisions.current[sessionId] ?? 0,
            });
            const text = intent.text;
            let result: Draft;
            try {
              result = await request<Draft>(
                store.save,
                { ...store.params(sessionId), text, expectedRevision: intent.expectedRevision },
                intent.id,
              );
            } catch (error) {
              // A read can establish a conflict or recover a committed write whose reply was lost.
              // A failed read leaves the exact original intent intact for an idempotent retry.
              const saved = await request<{ drafts: Record<string, Draft> }>(store.read).catch(
                () => null,
              );
              const remote = saved?.drafts[sessionId] ?? { text: '', revision: 0 };
              if (
                saved &&
                remote.requestId === intent.id &&
                remote.text === text &&
                remote.expectedRevision === intent.expectedRevision
              ) {
                result = remote;
              } else {
                if (saved && remote.revision !== intent.expectedRevision) {
                  delete pending.current[sessionId];
                  setConflict(sessionId, remote);
                }
                throw error;
              }
            }
            delete pending.current[sessionId];
            savedValues.current[sessionId] = result;
            revisions.current[sessionId] = result.revision;
            if (text === (values.current[sessionId] ?? '')) dirty.current.delete(sessionId);
          }),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
    })().finally(() => {
      saving.current = null;
    });
    return saving.current;
  }
  async function resolveConflict(sessionId: string, choice: 'mine' | 'saved') {
    if (!enabled) throw new Error('Reconnect before choosing a draft.');
    if (saving.current) await saving.current.catch(() => {});
    const conflict = conflictValues.current[sessionId];
    if (!conflict) return;
    const localText = values.current[sessionId] ?? '';
    const saved = await request<{ drafts: Record<string, Draft> }>(store.read);
    const remote = saved.drafts[sessionId] ?? { text: '', revision: 0 };
    if (remote.revision !== conflict.revision || remote.text !== conflict.text) {
      setConflict(sessionId, remote);
      throw new Error('The saved draft changed again. Review the updated copy before choosing.');
    }
    if (localText !== (values.current[sessionId] ?? ''))
      throw new Error('Your draft changed while checking. Review it and choose again.');
    savedValues.current[sessionId] = remote;
    revisions.current[sessionId] = remote.revision;
    delete pending.current[sessionId];
    if (choice === 'saved') {
      values.current = { ...values.current, [sessionId]: remote.text };
      dirty.current.delete(sessionId);
      render({ ...values.current });
      setConflict(sessionId);
      return;
    }
    // Keep the comparison visible while the selected draft is being saved.
    const next = { ...conflictValues.current };
    delete next[sessionId];
    conflictValues.current = next;
    try {
      await flushDrafts();
    } catch (error) {
      if (dirty.current.has(sessionId)) {
        if (!conflictValues.current[sessionId])
          report(
            'Your draft is still here but could not be saved. Keep this window open and reconnect.',
          );
        throw error;
      }
    } finally {
      renderConflicts({ ...conflictValues.current });
    }
  }
  useEffect(() => {
    if (enabled)
      void load().catch(() =>
        report(
          'Drafts could not be loaded. Your typed text is retained; reconnect before closing.',
        ),
      );
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !dirty.current.size) return;
    const timer = setTimeout(() => {
      void flushDrafts().catch(() => {
        if (![...dirty.current].every((id) => conflictValues.current[id]))
          report('Draft could not be saved. Keep this window open and reconnect to retry.');
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [drafts, enabled]);
  async function reloadDrafts() {
    if (dirty.current.size) throw new Error('Save your changes before refreshing drafts.');
    loading.current = null;
    await load();
  }
  return {
    drafts,
    setDrafts,
    flushDrafts,
    conflicts,
    resolveConflict,
    reloadDrafts,
    savedDraft: (id: string) => savedValues.current[id],
  };
}
