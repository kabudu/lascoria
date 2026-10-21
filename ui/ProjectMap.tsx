import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

type Folder = { id: string; name: string; path: string };
export type MapLayout = Record<string, { x: number; y: number }>;

/** Evenly around the goal, starting at the top; positions are percentages of the map. */
export function defaultPosition(index: number, count: number) {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(count, 1);
  return { x: 50 + 36 * Math.cos(angle), y: 50 + 34 * Math.sin(angle) };
}
const clamp = (value: number) => Math.min(92, Math.max(8, value));

/**
 * R15: the Project's folders as cards around its goal, echoing the spatial workspace. Moving a
 * card only changes this picture: folder order, the default folder and what Muse receives come
 * from the list below, which remains the complete keyboard path. Positions are a per-user
 * view preference, never part of the saved Project.
 */
export function ProjectMap({
  name,
  goal,
  folders,
  layout,
  disabled,
  onLayout,
  onOpen,
}: {
  name: string;
  goal?: string;
  folders: Folder[];
  layout: MapLayout;
  disabled: boolean;
  onLayout: (next: MapLayout) => void;
  /** Move focus to the folder's entry in the list. */
  onOpen: (id: string) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null);
  const moved = useRef(false);
  const place = (folder: Folder, index: number) =>
    dragging?.id === folder.id
      ? dragging
      : (layout[folder.id] ?? defaultPosition(index, folders.length));
  const at = (event: PointerEvent) => {
    const box = area.current!.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - box.left) / box.width) * 100),
      y: clamp(((event.clientY - box.top) / box.height) * 100),
    };
  };
  const nudge = (folder: Folder, index: number, event: KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 3;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    const current = place(folder, index);
    onLayout({
      ...layout,
      [folder.id]: { x: clamp(current.x + delta[0]), y: clamp(current.y + delta[1]) },
    });
  };
  return (
    <div className="project-map">
      <div ref={area} className="project-map-area" role="group" aria-label="Project map">
        <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
          {folders.map((folder, index) => {
            const p = place(folder, index);
            return (
              <line
                key={folder.id}
                x1="50"
                y1="50"
                x2={p.x}
                y2={p.y}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        <div className="project-map-goal" title={goal || undefined}>
          <strong>{name || 'Unnamed Project'}</strong>
          {goal && <span>{goal.length > 90 ? `${goal.slice(0, 90)}…` : goal}</span>}
        </div>
        {folders.map((folder, index) => {
          const p = place(folder, index);
          const label = folder.name || `Folder ${index + 1}`;
          return (
            <button
              key={folder.id}
              type="button"
              className={`project-map-card${index === 0 ? ' is-default' : ''}`}
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
              disabled={disabled}
              aria-label={`${label}${index === 0 ? ', default folder' : ''}. Enter edits it; arrow keys move the card.`}
              title={folder.path || 'No folder chosen yet'}
              onPointerDown={(event) => {
                if (disabled || event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                moved.current = false;
                setDragging({ id: folder.id, ...p });
              }}
              onPointerMove={(event) => {
                if (dragging?.id !== folder.id) return;
                moved.current = true;
                setDragging({ id: folder.id, ...at(event) });
              }}
              onPointerUp={(event) => {
                if (dragging?.id !== folder.id) return;
                const end = moved.current ? at(event) : null;
                setDragging(null);
                if (end) onLayout({ ...layout, [folder.id]: end });
              }}
              onPointerCancel={() => setDragging(null)}
              onClick={() => {
                if (!moved.current) onOpen(folder.id);
                moved.current = false;
              }}
              onKeyDown={(event) => nudge(folder, index, event)}
            >
              <span className="project-map-name">{label}</span>
              <small>
                {index === 0 ? 'Default · ' : ''}
                {folder.path ? folder.path.split(/[\\/]/).filter(Boolean).at(-1) : 'No folder yet'}
              </small>
            </button>
          );
        })}
      </div>
      <p className="hint">
        Arrange the cards however helps you think; it does not change the folder order, the default
        folder or what Muse receives.{' '}
        {Object.keys(layout).length > 0 && (
          <button type="button" className="link" disabled={disabled} onClick={() => onLayout({})}>
            Reset arrangement
          </button>
        )}
      </p>
    </div>
  );
}
