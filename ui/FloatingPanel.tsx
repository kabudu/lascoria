import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
export interface PanelLayout {
  x: number;
  y: number;
  collapsed: boolean;
}
export function FloatingPanel({
  title,
  layout,
  initial,
  onChange,
  children,
  badge,
  actions,
}: {
  title: string;
  layout?: PanelLayout;
  initial: { x: number; y: number };
  onChange: (value: PanelLayout) => void;
  children: ReactNode;
  badge?: number;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [position, setPosition] = useState(layout ?? { ...initial, collapsed: false });
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    setPosition(layout ?? { ...initial, collapsed: false });
  }, [layout, initial.x, initial.y]);
  useEffect(() => {
    const resize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const clamp = (x: number, y: number) => ({
    x: Math.max(
      8,
      Math.min(x, size.width - Math.min(ref.current?.offsetWidth ?? 280, size.width - 16) - 8),
    ),
    y: Math.max(76, Math.min(y, size.height - 64)),
  });
  const visible = clamp(position.x, position.y);
  const collapsed = layout?.collapsed ?? position.collapsed;
  return (
    <section
      ref={ref}
      className={`floating-panel ${title === 'Task inspector' ? 'inspector-window' : ''}`}
      aria-label={`${title} panel`}
      style={{
        left: visible.x,
        top: visible.y,
        maxHeight: Math.max(100, size.height - visible.y - 12),
      }}
    >
      <div className="panel-heading">
        <button
          className="panel-handle"
          aria-label={`Move ${title} panel`}
          title="Drag to move; use arrow keys when focused"
          onKeyDown={(event) => {
            const delta: Record<string, [number, number]> = {
              ArrowLeft: [-20, 0],
              ArrowRight: [20, 0],
              ArrowUp: [0, -20],
              ArrowDown: [0, 20],
            };
            if (!delta[event.key]) return;
            event.preventDefault();
            const [x, y] = delta[event.key];
            onChange({ ...position, ...clamp(visible.x + x, visible.y + y) });
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, left: visible.x, top: visible.y };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setPosition((previous) => ({
              ...previous,
              ...clamp(
                drag.current!.left + event.clientX - drag.current!.x,
                drag.current!.top + event.clientY - drag.current!.y,
              ),
            }));
          }}
          onPointerUp={() => {
            if (!drag.current) return;
            drag.current = null;
            onChange({ ...position, ...visible });
          }}
          onPointerCancel={() => {
            drag.current = null;
            onChange({ ...position, ...visible });
          }}
        >
          <span aria-hidden="true">⠿</span> {title}{' '}
          {badge !== undefined && <span className="count">{badge}</span>}
        </button>
        {actions && <div className="panel-actions">{actions}</div>}
        <button
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title} panel`}
          aria-expanded={!collapsed}
          onClick={() => onChange({ ...position, ...visible, collapsed: !collapsed })}
        >
          {collapsed ? '+' : '−'}
        </button>
      </div>
      <div className="panel-content" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
