import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Json } from './types';
import { FolderPath } from './FolderPath';
type Folder = { id: string; name: string; path: string; note?: string };
type Project = {
  id: string;
  name: string;
  revision: number;
  folders: Folder[];
  goal?: string;
};
const fresh = (): Project => ({
  id: crypto.randomUUID(),
  name: '',
  revision: 0,
  folders: [{ id: crypto.randomUUID(), name: 'App', path: '' }],
});

export function ProjectStart({
  started,
  disabled,
  economical,
  worktrees,
}: {
  started: (id: string) => void;
  disabled: boolean;
  /** R15: the supervisor can give each folder its own isolated worktree. */
  worktrees?: boolean;
  /** T4: start with the lowest reasoning effort the model offers. */
  economical?: boolean;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project>(fresh);
  const [saved, setSaved] = useState<Project | null>(null);
  const [busy, setBusy] = useState(true);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [task, setTask] = useState('');
  const [model, setModel] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [attempt, setAttempt] = useState<{ operation: string; params: Json; id: string } | null>(
    null,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void request('project/list')
      .then((r) => {
        if (mounted.current) setProjects(r.projects);
      })
      .catch((e) => {
        if (mounted.current) setError(String(e));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  function edit(next: Project) {
    setProject(next);
    setSaved(null);
    setError('');
  }
  async function run(operation: string, params: Json) {
    if (busy || picking) return;
    const next = attempt ?? { operation, params, id: crypto.randomUUID() };
    setAttempt(next);
    setBusy(true);
    setError('');
    try {
      const result = await request(next.operation, next.params, next.id);
      if (!mounted.current) return;
      if (next.operation === 'project/save') {
        setAttempt(null);
        setProject(result);
        setSaved(result);
        setProjects((old) => [...old.filter((p) => p.id !== result.id), result]);
      } else if (next.operation === 'turn') {
        setAttempt(null);
        if (!['applied', 'accepted'].includes(result.status))
          setError('Check this session before starting another task.');
        started(next.params.sessionId);
      } else if (result.status === 'applied') {
        const taskRequest = {
          operation: 'turn',
          params: { sessionId: result.sessionId, text: task },
          id: `${next.id}_task`,
        };
        setAttempt(taskRequest);
        const turn = await request(taskRequest.operation, taskRequest.params, taskRequest.id);
        if (mounted.current) {
          setAttempt(null);
          if (!['applied', 'accepted'].includes(turn.status))
            setError('Check this session before starting another task.');
          started(result.sessionId);
        }
      } else {
        setError('Muse did not confirm this start. Check session history before trying again.');
      }
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const locked = busy || picking || !!attempt;
  return (
    <section className="project-setup" aria-label="Project setup">
      {projects.length > 0 && (
        <label>
          Saved project
          <select
            value={project.revision ? project.id : ''}
            disabled={locked}
            onChange={(e) => {
              const selected = projects.find((p) => p.id === e.target.value);
              const next = selected ?? fresh();
              setProject(next);
              setSaved(selected ?? null);
              setError('');
            }}
          >
            <option value="">New project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.id.slice(-8)}
              </option>
            ))}
          </select>
        </label>
      )}
      {project.revision > 0 && (
        <>
          <button
            type="button"
            disabled={locked}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await request('project/list');
                if (!mounted.current) return;
                setProjects(result.projects);
                const latest = result.projects.find((p: Project) => p.id === project.id);
                if (latest) {
                  setProject(latest);
                  setSaved(latest);
                  setError('');
                }
              } catch (e) {
                if (mounted.current) setError(String(e));
              } finally {
                if (mounted.current) setBusy(false);
              }
            }}
          >
            Reload saved project
          </button>
          <p className="muted">Reload replaces your unsaved setup with its latest saved version.</p>
        </>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run('project/save', {
            id: project.id,
            name: project.name,
            folders: project.folders,
            goal: project.goal ?? null,
            expectedRevision: project.revision,
          });
        }}
      >
        <label>
          Project name
          <input
            value={project.name}
            required
            maxLength={100}
            disabled={locked}
            onChange={(e) => edit({ ...project, name: e.target.value })}
          />
        </label>
        <label>
          Goal (optional)
          <textarea
            value={project.goal ?? ''}
            maxLength={1000}
            rows={2}
            disabled={locked}
            placeholder="What this Project is for, in a sentence or two"
            onChange={(e) => edit({ ...project, goal: e.target.value })}
          />
        </label>
        <p className="muted">
          Your first folder is the default working folder. Muse receives every folder through its
          native workspace context. Adding folders does not approve tool permissions.
        </p>
        <ol className="project-folders">
          {project.folders.map((folder, index) => (
            <li key={folder.id}>
              <div className="project-folder-heading">
                <strong>{index === 0 ? 'Default folder' : `Folder ${index + 1}`}</strong>
                <div className="row">
                  <button
                    type="button"
                    disabled={locked || index === 0}
                    aria-label={`Move ${folder.name || 'folder'} up`}
                    onClick={() => {
                      const folders = [...project.folders];
                      [folders[index - 1], folders[index]] = [folders[index], folders[index - 1]];
                      edit({ ...project, folders });
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={locked || index === project.folders.length - 1}
                    aria-label={`Move ${folder.name || 'folder'} down`}
                    onClick={() => {
                      const folders = [...project.folders];
                      [folders[index + 1], folders[index]] = [folders[index], folders[index + 1]];
                      edit({ ...project, folders });
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={locked || project.folders.length === 1}
                    aria-label={`Remove ${folder.name || 'folder'}`}
                    onClick={() =>
                      edit({
                        ...project,
                        folders: project.folders.filter((f) => f.id !== folder.id),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
              <label>
                Folder name
                <input
                  value={folder.name}
                  maxLength={100}
                  required
                  disabled={locked}
                  onChange={(e) =>
                    edit({
                      ...project,
                      folders: project.folders.map((f) =>
                        f.id === folder.id ? { ...f, name: e.target.value } : f,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Note (optional)
                <input
                  value={folder.note ?? ''}
                  maxLength={300}
                  disabled={locked}
                  placeholder="How this folder fits in"
                  onChange={(e) =>
                    edit({
                      ...project,
                      folders: project.folders.map((f) =>
                        f.id === folder.id ? { ...f, note: e.target.value } : f,
                      ),
                    })
                  }
                />
              </label>
              <FolderPath
                label="Full folder path"
                browseLabel={`Browse for folder ${index + 1}`}
                value={folder.path}
                disabled={locked}
                onPicking={setPicking}
                onChange={(path) =>
                  edit({
                    ...project,
                    folders: project.folders.map((f) => (f.id === folder.id ? { ...f, path } : f)),
                  })
                }
              />
            </li>
          ))}
        </ol>
        <div className="row">
          <button
            type="button"
            disabled={locked || project.folders.length >= 8}
            onClick={() =>
              edit({
                ...project,
                folders: [...project.folders, { id: crypto.randomUUID(), name: '', path: '' }],
              })
            }
          >
            Add folder
          </button>
          <button disabled={locked}>Save project</button>
        </div>
      </form>
      {saved && (
        <p role="status">
          Saved {saved.name} · {saved.folders.length} folders. Starts use revision {saved.revision}.
          Edits affect future sessions; existing sessions retain their original folders.
          {(saved.goal || saved.folders.some((f) => f.note)) &&
            ' Muse receives the goal and folder notes with the first task, as your description of the Project; they grant no permissions.'}
        </p>
      )}
      {worktrees ? (
        <>
          <label className="settings-choice">
            <input
              type="checkbox"
              checked={isolated}
              disabled={locked}
              onChange={(e) => setIsolated(e.target.checked)}
            />
            Give each folder its own isolated worktree from committed HEAD
          </label>
          <p className="muted">
            {isolated
              ? 'Every folder must be a Git repository root. Uncommitted changes stay in the original checkouts, and each folder commits on its own task branch. The session keeps these folders; a changed Project needs a new session.'
              : 'Muse works directly in these existing folders.'}
          </p>
        </>
      ) : (
        <p className="muted">Project sessions work in these existing folders.</p>
      )}
      <label>
        Project model
        <select value={model} disabled={locked} onChange={(e) => setModel(e.target.value)}>
          <option value="">Muse catalog default</option>
          <option value="muse-wonder-1.0">Muse Wonder 1.0</option>
          <option value="muse-spark-1.3">Muse Spark 1.3</option>
        </select>
      </label>
      <label>
        Project task
        <textarea
          value={task}
          required
          maxLength={16000}
          disabled={locked}
          onChange={(e) => setTask(e.target.value)}
          placeholder="What should Muse work on across these folders?"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {busy ? (
        <p className="muted" aria-live="polite">
          {attempt?.operation === 'project/save'
            ? 'Saving project…'
            : attempt?.operation === 'start'
              ? 'Starting Muse session…'
              : attempt?.operation === 'turn'
                ? 'Sending your task…'
                : 'Loading saved projects…'}
        </p>
      ) : attempt ? (
        <div className="row">
          <button disabled={busy} onClick={() => void run(attempt.operation, attempt.params)}>
            Retry exact request
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setAttempt(null);
              setError('Check the saved project and session list before starting again.');
            }}
          >
            Review before editing
          </button>
        </div>
      ) : (
        <button
          className="primary"
          disabled={disabled || locked || !saved || !task.trim()}
          onClick={() =>
            void run('start', {
              projectId: saved!.id,
              projectRevision: saved!.revision,
              name: saved!.name,
              ...(model ? { modelId: model } : {}),
              ...(economical ? { effortPreset: 'economical' } : {}),
              ...(worktrees && isolated ? { isolated: true } : {}),
            })
          }
        >
          Start project session
        </button>
      )}
    </section>
  );
}
