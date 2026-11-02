import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Prefs, Task } from './types';
import { freeCanvasFrame, type CanvasFrame } from './model';
import { CARD, intersects, vacantCard } from './constellation';

const chrome =
  '.floating-panel, .workspace-title, .surface-toolbar, .surface-foot, .canvas-discovery, .notification-stack';
const inflate = (r: CanvasFrame, gap: number) => ({
  x: r.x - gap,
  y: r.y - gap,
  width: r.width + gap * 2,
  height: r.height + gap * 2,
});
function view(element: HTMLElement, prefs: Prefs) {
  const bounds = element.getBoundingClientRect();
  const offset = {
    x: (prefs.canvasOffset?.x ?? 0) - element.scrollLeft,
    y: (prefs.canvasOffset?.y ?? 0) - element.scrollTop,
  };
  const obstacles = [...document.querySelectorAll(chrome)]
    .filter(
      (el) =>
        el.getClientRects().length &&
        el.getBoundingClientRect().width > 0 &&
        el.getBoundingClientRect().height > 0,
    )
    .map((el) => {
      const r = el.getBoundingClientRect();
      return inflate(
        { x: r.x - bounds.x, y: r.y - bounds.y, width: r.width, height: r.height },
        12,
      );
    });
  return {
    offset,
    obstacles,
    width: element.clientWidth,
    height: element.clientHeight,
    zoom: Math.max(0.02, Math.min(2, prefs.zoom ?? 1)),
  };
}

/** One-time placement per card, persisted in the existing presentation positions.
 * Camera/resize/status changes only update visibility, never relocate saved cards. */
export function useConstellation(
  ref: RefObject<HTMLDivElement | null>,
  nodes: Task[],
  prefs: Prefs,
  fallback: Record<string, { x: number; y: number }>,
  update: (patch: Partial<Prefs>) => void,
  identity: string,
  enabled: boolean,
  reserved: Task[],
) {
  const automatic = useRef<Record<string, { x: number; y: number }>>({});
  const owner = useRef<string | undefined>(undefined);
  if (owner.current !== reserved[0]?.sessionId) {
    owner.current = reserved[0]?.sessionId;
    automatic.current = {};
  }
  const [temporary, setTemporary] = useState(false);
  const current = useRef({ nodes, prefs, fallback, update });
  current.current = { nodes, prefs, fallback, update };
  const [outside, setOutside] = useState<string[]>([]);
  const [noticeHeight, setNoticeHeight] = useState(0);
  const [revision, tick] = useState(0);
  const placementFrame = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame === null)
        frame = requestAnimationFrame(() => {
          frame = null;
          tick((n) => n + 1);
        });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    document.querySelectorAll(chrome).forEach((n) => observer.observe(n));
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      if (placementFrame.current !== null) {
        cancelAnimationFrame(placementFrame.current);
        placementFrame.current = null;
      }
    };
  }, [identity, ref]);
  // Intentionally measure after each React commit: panel movement and disclosure are
  // presentation changes; a ResizeObserver alone cannot observe position changes.
  useLayoutEffect(() => {
    void revision;
    if (!enabled) return;
    const el = ref.current;
    if (!el) {
      if (outside.length) setOutside([]);
      return;
    }
    const notices = Math.ceil(
      document.querySelector('.notification-stack')?.getBoundingClientRect().height ?? 0,
    );
    if (notices !== noticeHeight) setNoticeHeight(notices);
    const retained = new Set(reserved.map((n) => n.id));
    for (const id of Object.keys(automatic.current))
      if (!retained.has(id)) delete automatic.current[id];
    const v = view(el, prefs),
      positions = { ...automatic.current, ...prefs.positions };
    const screen = (p: { x: number; y: number }) => ({
      x: p.x * v.zoom + v.offset.x,
      y: p.y * v.zoom + v.offset.y,
      width: CARD.width * v.zoom,
      height: CARD.height * v.zoom,
    });
    const viewport = { x: 0, y: 0, width: v.width, height: v.height };
    const occupied = reserved
      .filter((n) => positions[n.id])
      .map((n) => inflate(screen(positions[n.id]), 12))
      .filter((r) => intersects(r, viewport));
    let added = 0;
    for (const node of nodes) {
      if (positions[node.id] || added >= 32 || placementFrame.current !== null) continue;
      const x = 12,
        y = 12;
      const slot = vacantCard(
        { x, y, width: v.width - 12 - x, height: v.height - 12 - y },
        [...v.obstacles, ...occupied],
        CARD.width * v.zoom,
        CARD.height * v.zoom,
      );
      const point = slot
        ? { x: (slot.x - v.offset.x) / v.zoom, y: (slot.y - v.offset.y) / v.zoom }
        : {
            x: Math.max(0, (v.width + 24 - v.offset.x) / v.zoom),
            y: Math.max(
              0,
              ...reserved
                .filter((n) => positions[n.id])
                .map((n) => positions[n.id].y + CARD.height + 40),
            ),
          };
      positions[node.id] = point;
      automatic.current[node.id] = point;
      occupied.push(inflate(screen(point), 12));
      added++;
    }
    if (added) {
      if (nodes.some((n) => !positions[n.id]))
        placementFrame.current = requestAnimationFrame(() => {
          placementFrame.current = null;
          tick((n) => n + 1);
        });
      // Automatic geometry must not exceed the supervisor's 48KB preference
      // boundary or prevent unrelated drafts/settings from being saved.
      const bytes = new TextEncoder().encode(JSON.stringify({ ...prefs, positions })).length;
      if (bytes <= 44000) {
        update({ positions });
        if (temporary) setTemporary(false);
      } else {
        if (!temporary) setTemporary(true);
        tick((n) => n + 1);
      }
    }
    const hidden = nodes
      .filter((n) => {
        const r = screen(positions[n.id] ?? fallback[n.id]);
        return (
          r.x < 12 ||
          r.y < 12 ||
          r.x + r.width > v.width - 12 ||
          r.y + r.height > v.height - 12 ||
          v.obstacles.some((o) => intersects(r, o))
        );
      })
      .map((n) => n.id);
    if (hidden.join('|') !== outside.join('|')) setOutside(hidden);
  });
  function reveal(id: string) {
    const el = ref.current;
    if (!el) return false;
    const { prefs, nodes, fallback, update } = current.current;
    if (!nodes.some((n) => n.id === id)) return false;
    const v = view(el, prefs);
    const p = prefs.positions?.[id] ?? automatic.current[id] ?? fallback[id];
    const rect = {
      x: p.x * v.zoom + v.offset.x,
      y: p.y * v.zoom + v.offset.y,
      width: CARD.width * v.zoom,
      height: CARD.height * v.zoom,
    };
    if (
      rect.x >= 12 &&
      rect.y >= 12 &&
      rect.x + rect.width <= v.width - 12 &&
      rect.y + rect.height <= v.height - 12 &&
      !v.obstacles.some((o) => intersects(rect, o))
    )
      return true;
    const frame = freeCanvasFrame(v.width, v.height, v.obstacles);
    if (frame.width < 48 || frame.height < 48) return false;
    const zoom = Math.min(
      v.zoom,
      (frame.width - 24) / CARD.width,
      (frame.height - 24) / CARD.height,
    );
    el.scrollTo({ left: 0, top: 0 });
    update({
      zoom,
      canvasOffset: {
        x: frame.x + (frame.width - CARD.width * zoom) / 2 - p.x * zoom,
        y: frame.y + (frame.height - CARD.height * zoom) / 2 - p.y * zoom,
      },
      viewport: { x: 0, y: 0 },
    });
    return true;
  }
  return {
    outside,
    reveal,
    noticeHeight,
    automatic: automatic.current,
    temporary: temporary && Object.keys(automatic.current).some((id) => !prefs.positions?.[id]),
  };
}
