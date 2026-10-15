import { useEffect, useRef, useState } from 'react';
import type { SkillCatalogEntry } from '@muse-code/sdk/dist/src/msp.js';
import { request } from './api';

export function SkillPicker({
  sessionId,
  text,
  select,
  openUsage,
}: {
  sessionId: string;
  text: string;
  select: (text: string) => void;
  openUsage: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [dismissed, setDismissed] = useState<string>();
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([]);
  const [state, setState] = useState('');
  const query = /^\/([^\s]*)$/.exec(text)?.[1];
  useEffect(() => setDismissed(undefined), [text, sessionId]);
  useEffect(() => {
    if (query === undefined) return;
    let cancelled = false;
    setSkills([]);
    setState('Reading Muse skills…');
    const timer = setTimeout(() => {
      void request<{ skills: SkillCatalogEntry[] }>('skills', { sessionId }).then(
        (result) => {
          if (!cancelled) {
            setSkills(result.skills);
            setState('');
          }
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
  }, [sessionId, query]);
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
  const matches = skills
    .filter((skill) => skill.selector !== 'usage')
    .filter((skill) =>
      `${skill.selector} ${skill.displayName} ${skill.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
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
      {'usage'.startsWith(query.toLowerCase()) && (
        <button type="button" onClick={openUsage}>
          /usage · View subscription allowance
        </button>
      )}
      {state && <p role="status">{state}</p>}
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
          <strong>/{skill.selector}</strong> · {skill.displayName} · {skill.source}
          <span className="hint">
            {skill.description}
            {skill.argumentHint ? ` · ${skill.argumentHint}` : ''}
          </span>
        </button>
      ))}
      {matches.length > 100 && <p>Type more to narrow {matches.length} skills.</p>}
    </section>
  );
}
