import { useEffect, useRef, useState } from 'react';
import type { SkillCatalogEntry } from '@muse-code/sdk/dist/src/msp.js';
import { request } from './api';

/** Lascoria's own shortcuts. A Muse skill with one of these names cannot be typed directly. */
export const LOCAL_COMMANDS = ['usage'];

// Session-scoped catalog cache (R9). A catalog is reused until the session's Muse host restarts
// (generation) or Muse reports that its invocable skills changed (skillsRevision), so typing
// filters locally instead of asking Muse on every keystroke.
const catalogs = new Map<string, { key: string; skills: SkillCatalogEntry[] }>();

export function SkillPicker({
  sessionId,
  catalogKey,
  text,
  select,
  openUsage,
}: {
  sessionId: string;
  /** Changes whenever the cached catalog may be stale: host generation and skill/changed. */
  catalogKey: string;
  text: string;
  select: (text: string) => void;
  openUsage: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [dismissed, setDismissed] = useState<string>();
  const cached = catalogs.get(sessionId);
  const [skills, setSkills] = useState<SkillCatalogEntry[]>(
    cached?.key === catalogKey ? cached.skills : [],
  );
  const [state, setState] = useState('');
  const query = /^\/([^\s]*)$/.exec(text)?.[1];
  const open = query !== undefined;
  useEffect(() => setDismissed(undefined), [text, sessionId]);
  useEffect(() => {
    if (!open) return;
    const hit = catalogs.get(sessionId);
    if (hit?.key === catalogKey) {
      setSkills(hit.skills);
      setState('');
      return;
    }
    let cancelled = false;
    setSkills([]);
    setState('Reading Muse skills…');
    const timer = setTimeout(() => {
      void request<{ skills: SkillCatalogEntry[] }>('skills', { sessionId }).then(
        (result) => {
          if (cancelled) return;
          catalogs.set(sessionId, { key: catalogKey, skills: result.skills });
          setSkills(result.skills);
          setState('');
        },
        () => {
          if (!cancelled) setState('Muse skills are unavailable. Retry by reopening the picker.');
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, catalogKey, open]);
  useEffect(() => {
    const composer = document.getElementById('message');
    const navigate = (event: KeyboardEvent) => {
      if (query === undefined || dismissed === text) return;
      if (event.key === 'Escape') {
        setDismissed(text);
        event.preventDefault();
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        panel.current?.querySelector('button')?.focus();
      }
    };
    composer?.addEventListener('keydown', navigate);
    return () => composer?.removeEventListener('keydown', navigate);
  }, [query, dismissed, text]);
  if (query === undefined || dismissed === text) return null;
  const needle = query.toLowerCase();
  const matching = skills.filter((skill) =>
    `${skill.selector} ${skill.displayName} ${skill.description}`.toLowerCase().includes(needle),
  );
  const matches = matching.filter((skill) => !LOCAL_COMMANDS.includes(skill.selector));
  const shadowed = matching.filter((skill) => LOCAL_COMMANDS.includes(skill.selector));
  // Several skills can share a display name; show which source each one comes from.
  const names = new Map<string, number>();
  for (const skill of matches)
    names.set(skill.displayName, (names.get(skill.displayName) ?? 0) + 1);
  const local = 'usage'.startsWith(needle);
  return (
    <section
      ref={panel}
      className="skill-picker"
      aria-label="Muse shortcuts"
      onKeyDown={(event) => {
        const buttons = [...(panel.current?.querySelectorAll('button') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(text);
          document.getElementById('message')?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next =
            buttons[
              (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            ];
          next?.focus();
          next?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Tab' && !event.shiftKey && index >= 0) {
          event.preventDefault();
          buttons[index].click();
        }
      }}
    >
      <p className="hint">Select a shortcut, add arguments, then submit when ready.</p>
      {local && (
        <div role="group" aria-label="Lascoria commands">
          <h3 className="skill-group">Lascoria</h3>
          <button type="button" onClick={openUsage}>
            <strong>/usage</strong> · Account &amp; usage
            <span className="hint">
              Opens your subscription allowance. Runs locally, never sent to Muse.
            </span>
          </button>
        </div>
      )}
      <div role="group" aria-label="Muse skills">
        <h3 className="skill-group">Muse skills</h3>
        {state && <p role="status">{state}</p>}
        {!state && (
          <p className="visually-hidden" role="status">
            {matches.length === 1 ? '1 Muse skill' : `${matches.length} Muse skills`}
          </p>
        )}
        {!state && matches.length === 0 && <p>No matching Muse skills.</p>}
        {matches.slice(0, 100).map((skill) => (
          <button
            type="button"
            key={skill.selector}
            onClick={() => {
              select(`/${skill.selector} `);
              document.getElementById('message')?.focus();
            }}
          >
            <strong>/{skill.selector}</strong> · {skill.displayName}{' '}
            <span
              className={`skill-source ${(names.get(skill.displayName) ?? 0) > 1 ? 'duplicate' : ''}`}
            >
              {skill.source}
            </span>
            <span className="hint">
              {skill.description}
              {skill.argumentHint ? ` · ${skill.argumentHint}` : ''}
            </span>
          </button>
        ))}
        {matches.length > 100 && <p>Type more to narrow {matches.length} skills.</p>}
        {shadowed.map((skill) => (
          <p className="hint" key={skill.selector}>
            The {skill.source} skill /{skill.selector} is not shown: typing /{skill.selector} opens
            Lascoria&apos;s Account &amp; usage instead, so that shortcut cannot invoke it.
          </p>
        ))}
      </div>
    </section>
  );
}
