import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Prefs } from './types';

/**
 * Settings sections, grouped and in navigation order. Keywords let the search box find a
 * section by what it controls, not only by its title.
 */
export const SETTINGS_GROUPS = [
  {
    name: 'Lascoria',
    sections: [
      ['general', 'General', 'theme appearance dark light close window quit background'],
      ['editor', 'Editor', 'open editor code cursor zed sublime folder file'],
      ['notifications', 'Notifications', 'desktop alerts questions approvals finished sessions'],
      ['updates', 'Updates', 'version upgrade release beta channel install download'],
    ],
  },
  {
    name: 'Muse',
    sections: [
      ['usage', 'Account & usage', 'subscription allowance weekly window toolbar plan'],
      [
        'efficiency',
        'Token efficiency',
        'tokens budget cost effort economical compaction context repeat loop concurrent tasks',
      ],
    ],
  },
  {
    name: 'Integrations',
    sections: [
      [
        'decisions',
        'Decision assistance',
        'BYOK Jev TypeSafe SubQ OpenAI provider API key advice decisions',
      ],
    ],
  },
  {
    name: 'Data & privacy',
    sections: [
      ['data', 'Data & backups', 'backup export import restore cleanup remove archive'],
      ['support', 'Support report', 'diagnostics troubleshooting help report'],
    ],
  },
] as const;
export const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((group) =>
  group.sections.map(([id, label]) => [id, label] as const),
);
export type SettingsSection = (typeof SETTINGS_GROUPS)[number]['sections'][number][0];
export const isSettingsSection = (value: unknown): value is SettingsSection =>
  SETTINGS_SECTIONS.some(([id]) => id === value);

/**
 * One place for app settings: grouped sections on the left, the chosen section on the right
 * (stacked on narrow windows), and a search box that narrows the list. Arrow keys move
 * between visible sections.
 */
export function SettingsShell({
  section,
  open,
  available,
  children,
}: {
  section: SettingsSection;
  open: (section: SettingsSection) => void;
  available: (section: SettingsSection) => boolean;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const groups = SETTINGS_GROUPS.map((group) => ({
    name: group.name,
    sections: group.sections.filter(
      ([id, label, words]) =>
        available(id) && (!needle || `${label} ${words}`.toLowerCase().includes(needle)),
    ),
  })).filter((group) => group.sections.length);
  const visible = groups.flatMap((group) => group.sections);
  return (
    <div className="settings-shell">
      <nav aria-label="Settings sections">
        <input
          type="search"
          className="settings-search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && visible[0]) open(visible[0][0]);
          }}
        />
        {groups.length === 0 && <p className="hint">No settings match.</p>}
        {groups.map((group) => (
          <div key={group.name} role="group" aria-label={group.name}>
            <p className="settings-group-name">{group.name}</p>
            <ul>
              {group.sections.map(([id, label]) => {
                const index = visible.findIndex(([v]) => v === id);
                return (
                  <li key={id}>
                    <button
                      id={`settings-nav-${id}`}
                      aria-current={section === id ? 'page' : undefined}
                      onClick={() => open(id)}
                      onKeyDown={(event) => {
                        const next =
                          event.key === 'ArrowDown'
                            ? visible[(index + 1) % visible.length]
                            : event.key === 'ArrowUp'
                              ? visible[(index + visible.length - 1) % visible.length]
                              : undefined;
                        if (!next) return;
                        event.preventDefault();
                        open(next[0]);
                        document.getElementById(`settings-nav-${next[0]}`)?.focus();
                      }}
                    >
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="settings-section">{children}</div>
    </div>
  );
}

export function GeneralSettings({
  prefs,
  update,
}: {
  prefs: Prefs;
  update: (patch: Partial<Prefs>) => void;
}) {
  return (
    <section className="settings-group" aria-label="General settings">
      <fieldset>
        <legend>Appearance</legend>
        {(['light', 'dark'] as const).map((theme) => (
          <label key={theme} className="settings-choice">
            <input
              type="radio"
              name="theme"
              checked={(prefs.theme ?? 'light') === theme}
              onChange={() => update({ theme })}
            />
            {theme === 'light' ? 'Light' : 'Dark'}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>When you close the window</legend>
        {(
          [
            [undefined, 'Ask each time'],
            ['keepRunning', 'Keep work running in the background'],
            ['pause', 'Pause work and quit'],
          ] as const
        ).map(([value, label]) => (
          <label key={label} className="settings-choice">
            <input
              type="radio"
              name="close-behaviour"
              checked={prefs.closeBehavior === value}
              onChange={() => update({ closeBehavior: value })}
            />
            {label}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

type Editor = { id: string; name: string; available: boolean };

/** D2: which editor "Open in editor" uses. Custom editors come from the native chooser. */
export function EditorSettings({
  prefs,
  update,
}: {
  prefs: Prefs;
  update: (patch: Partial<Prefs>) => void;
}) {
  const [editors, setEditors] = useState<Editor[]>([]);
  const [error, setError] = useState('');
  const load = () => invoke<Editor[]>('list_editors').then(setEditors, (e) => setError(String(e)));
  useEffect(() => {
    void load();
  }, []);
  const chosen = prefs.editor ?? 'system';
  return (
    <section className="settings-group" aria-label="Editor settings">
      <p>
        <strong>Open in editor</strong> in the task inspector opens the session&apos;s folder, or a
        changed file, in this editor. Lascoria passes only the path; it does not change your
        editor&apos;s settings.
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset>
        <legend>Open folders and files with</legend>
        {editors.map((editor) => (
          <label key={editor.id} className="settings-choice">
            <input
              type="radio"
              name="editor"
              checked={chosen === editor.id}
              disabled={!editor.available}
              onChange={() => update({ editor: editor.id })}
            />
            {editor.name}
            {!editor.available && <span className="hint"> · not found on this computer</span>}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        onClick={async () => {
          setError('');
          try {
            const name = await invoke<string | null>('pick_editor_application');
            if (!name) return;
            await load();
            update({ editor: 'custom' });
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Choose another editor…
      </button>
    </section>
  );
}

const BUDGETS = [0, 50_000, 100_000, 250_000, 500_000, 1_000_000];

/**
 * T3/T4: budgets, warnings and economical defaults. Warnings only describe what Muse reported;
 * anything that changes what Muse does (stopping a task, lower effort) is off until chosen.
 */
export function EfficiencySettings({
  prefs,
  update,
}: {
  prefs: Prefs;
  update: (patch: Partial<Prefs>) => void;
}) {
  const current = prefs.efficiency ?? {};
  const set = (patch: Partial<NonNullable<Prefs['efficiency']>>) =>
    update({ efficiency: { ...current, ...patch } });
  const budget = current.taskBudget ?? 0;
  return (
    <section className="settings-group" aria-label="Token efficiency settings">
      <p>
        Keep tasks economical without losing your instructions or history. Token figures come from
        Muse after each model call; the inspector&apos;s Token use line shows them.
      </p>
      <fieldset>
        <legend>Task budget</legend>
        <label>
          Warn when one task uses more than
          <select
            value={budget}
            onChange={(event) => set({ taskBudget: Number(event.currentTarget.value) })}
          >
            {BUDGETS.map((value) => (
              <option key={value} value={value}>
                {value ? `${value.toLocaleString()} tokens` : 'No budget'}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-choice">
          <input
            type="checkbox"
            disabled={!budget}
            checked={Boolean(current.stopOverBudget) && budget > 0}
            onChange={(event) => set({ stopOverBudget: event.currentTarget.checked })}
          />
          Stop a task when it goes over
        </label>
        <p className="hint">
          A soft limit: Muse reports usage after each model call, so a task can go a little over
          before it stops. Work done so far is kept.
        </p>
      </fieldset>
      <fieldset>
        <legend>Warnings</legend>
        <label>
          Ask before starting a task when
          <select
            value={current.concurrentTasks ?? 0}
            onChange={(event) => set({ concurrentTasks: Number(event.currentTarget.value) })}
          >
            <option value={0}>never</option>
            {[2, 3, 4, 5, 8].map((n) => (
              <option key={n} value={n}>
                {n} or more
              </option>
            ))}
          </select>
          tasks are already running
        </label>
        <label>
          Warn when Muse repeats the same tool call
          <select
            value={current.repeatThreshold ?? 3}
            onChange={(event) => set({ repeatThreshold: Number(event.currentTarget.value) })}
          >
            <option value={0}>never</option>
            {[3, 5, 8].map((n) => (
              <option key={n} value={n}>
                {n} times
              </option>
            ))}
          </select>
          in one task
        </label>
        <label className="settings-choice">
          <input
            type="checkbox"
            checked={current.suggestCompaction !== false}
            onChange={(event) => set({ suggestCompaction: event.currentTarget.checked })}
          />
          Suggest compacting the conversation when it nears the model&apos;s context limit
        </label>
        <p className="hint">
          Compacting is Muse&apos;s own summary of older messages, run only when you choose it;
          Lascoria never shortens your transcript.
        </p>
      </fieldset>
      <fieldset>
        <legend>New sessions</legend>
        {(
          [
            ['balanced', 'Balanced: the reasoning effort Muse recommends for the model'],
            [
              'economical',
              'Economical: the lowest reasoning effort the model offers. Raise it for a session in Session model & effort.',
            ],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="settings-choice">
            <input
              type="radio"
              name="effort-preset"
              checked={(current.preset ?? 'balanced') === value}
              onChange={() => set({ preset: value })}
            />
            {label}
          </label>
        ))}
      </fieldset>
    </section>
  );
}
