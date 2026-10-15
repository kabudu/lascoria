import { useEffect, useRef, useState } from 'react';
import { request } from './api';
type Draft = { text: string; revision: number };
export function useDurableDrafts(enabled: boolean, report: (message: string) => void) {
  const [drafts, render] = useState<Record<string, string>>({});
  const values = useRef<Record<string, string>>({});
  const revisions = useRef<Record<string, number>>({});
  const dirty = useRef(new Set<string>());
  const loading = useRef<Promise<void> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const ready = useRef(false);
  const pending = useRef<Record<string, { id: string; text: string; expectedRevision: number }>>(
    {},
  );
  function load() {
    return (loading.current ??= request<{ drafts: Record<string, Draft> }>('drafts/get')
      .then((result) => {
        for (const [id, draft] of Object.entries(result.drafts)) {
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
        const ids = [...dirty.current].slice(0, 4);
        const results = await Promise.allSettled(
          ids.map(async (sessionId) => {
            const intent = (pending.current[sessionId] ??= {
              id: crypto.randomUUID(),
              text: values.current[sessionId] ?? '',
              expectedRevision: revisions.current[sessionId] ?? 0,
            });
            const text = intent.text;
            const result = await request<Draft>(
              'drafts/save',
              { sessionId, text, expectedRevision: intent.expectedRevision },
              intent.id,
            );
            delete pending.current[sessionId];
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
      void flushDrafts().catch(() =>
        report(
          'Draft was not saved. Keep this window open and retry; another window may have changed this draft.',
        ),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [drafts, enabled]);
  return { drafts, setDrafts, flushDrafts };
}
