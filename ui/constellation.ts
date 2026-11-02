import type { Task } from './types';
import type { CanvasFrame } from './model';

export const CARD = { width: 220, height: 140 };
export const intersects = (a: CanvasFrame, b: CanvasFrame) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
export function sessionSequence(nodes: Task[]) {
  const turns = nodes.filter((n) => n.provenance === 'derived' && !n.parentId && !n.item);
  return turns
    .slice(1)
    .flatMap((to, i) => (turns[i].sessionId === to.sessionId ? [{ from: turns[i], to }] : []));
}

/** Exact rectangular free-space search, using obstacle edges rather than a coarse grid.
 * Work is O(n² log n); callers pass only obstacles intersecting the viewport. */
export function vacantCard(
  frame: CanvasFrame,
  obstacles: CanvasFrame[],
  width: number,
  height: number,
) {
  if (width > frame.width || height > frame.height) return null;
  const right = frame.x + frame.width - width,
    bottom = frame.y + frame.height - height;
  const blocks = obstacles.filter((b) => intersects(frame, b));
  const xs = [
    ...new Set([frame.x, right, ...blocks.flatMap((b) => [b.x - width, b.x + b.width])]),
  ].filter((x) => x >= frame.x && x <= right);
  let best = { x: 0, y: 0, score: Infinity };
  const target = { x: (frame.x + right) / 2, y: (frame.y + bottom) / 2 };
  for (const x of xs) {
    const intervals = blocks
      .filter((b) => x < b.x + b.width && x + width > b.x)
      .map((b) => [b.y - height, b.y + b.height])
      .sort((a, b) => a[0] - b[0]);
    let cursor = frame.y;
    const consider = (lo: number, hi: number) => {
      if (lo > hi) return;
      const y = Math.max(lo, Math.min(hi, target.y));
      const score = (x - target.x) ** 2 + (y - target.y) ** 2;
      if (score < best.score) best = { x, y, score };
    };
    for (const [start, end] of intervals) {
      if (end < cursor) continue;
      consider(cursor, Math.min(start, bottom));
      cursor = Math.max(cursor, end);
      if (cursor > bottom) break;
    }
    consider(cursor, bottom);
  }
  return Number.isFinite(best.score) ? { x: best.x, y: best.y } : null;
}

export function connectionCurve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    const direction = dx >= 0 ? 1 : -1;
    const start = a.x + (direction > 0 ? CARD.width : 0),
      end = b.x + (direction > 0 ? 0 : CARD.width);
    const bend = Math.max(24, Math.min(100, Math.abs(end - start) * 0.45));
    return `M ${start} ${a.y + CARD.height / 2} C ${start + direction * bend} ${a.y + CARD.height / 2}, ${end - direction * bend} ${b.y + CARD.height / 2}, ${end} ${b.y + CARD.height / 2}`;
  }
  const direction = dy >= 0 ? 1 : -1;
  const start = a.y + (direction > 0 ? CARD.height : 0),
    end = b.y + (direction > 0 ? 0 : CARD.height);
  const bend = Math.max(24, Math.min(100, Math.abs(end - start) * 0.45));
  return `M ${a.x + CARD.width / 2} ${start} C ${a.x + CARD.width / 2} ${start + direction * bend}, ${b.x + CARD.width / 2} ${end - direction * bend}, ${b.x + CARD.width / 2} ${end}`;
}
