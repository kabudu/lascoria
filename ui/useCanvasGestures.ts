import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { zoomAtPoint, normalizedWheel, type CanvasCamera } from './model';

type PinchEvent = Event & { scale?: number; clientX?: number; clientY?: number };
export function useCanvasGestures(
  ref: RefObject<HTMLDivElement | null>,
  surface: string,
  read: () => CanvasCamera,
  publish: (camera: CanvasCamera) => void,
  dragging: () => boolean,
) {
  const handlers = useRef({ read, publish, dragging });
  handlers.current = { read, publish, dragging };
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let pointer: { x: number; y: number } | undefined;
    let pinch: { zoom: number; anchor: { x: number; y: number } } | undefined;
    let suppressWheelUntil = 0;
    const rememberPointer = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const anchor = (event: PinchEvent) => {
      const rect = element.getBoundingClientRect();
      if (
        event.clientX !== undefined &&
        event.clientY !== undefined &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      )
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      return pointer ?? { x: rect.width / 2, y: rect.height / 2 };
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (handlers.current.dragging() || pinch || performance.now() < suppressWheelUntil) return;
      const camera = handlers.current.read();
      const delta = normalizedWheel(
        event.deltaX,
        event.deltaY,
        event.deltaMode,
        element.clientHeight,
      );
      if (event.ctrlKey || event.metaKey) {
        handlers.current.publish(
          zoomAtPoint(
            camera,
            camera.zoom * Math.exp(-Math.max(-300, Math.min(300, delta.y)) * 0.002),
            anchor(event),
          ),
        );
      } else {
        // Native trackpad momentum arrives as more wheel packets. Do not invent
        // a second inertial animation or make panel scrolling a canvas gesture.
        handlers.current.publish({
          ...camera,
          offset: { x: camera.offset.x - delta.x, y: camera.offset.y - delta.y },
        });
      }
    };
    const start = (event: PinchEvent) => {
      event.preventDefault();
      if (handlers.current.dragging()) return;
      pinch = { zoom: handlers.current.read().zoom, anchor: anchor(event) };
    };
    const change = (event: PinchEvent) => {
      if (!pinch) return;
      event.preventDefault();
      if (!Number.isFinite(event.scale) || event.scale! <= 0) return;
      handlers.current.publish(
        zoomAtPoint(handlers.current.read(), pinch.zoom * event.scale!, pinch.anchor),
      );
    };
    const end = (event: Event) => {
      if (!pinch) return;
      event.preventDefault();
      pinch = undefined;
      // Suppress a possible wheel tail for the same physical pinch.
      suppressWheelUntil = performance.now() + 80;
    };
    element.addEventListener('pointermove', rememberPointer);
    element.addEventListener('pointerenter', rememberPointer);
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('gesturestart', start, { passive: false });
    window.addEventListener('gesturechange', change, { passive: false });
    window.addEventListener('gestureend', end, { passive: false });
    const blur = () => {
      pinch = undefined;
      suppressWheelUntil = 0;
    };
    window.addEventListener('blur', blur);
    return () => {
      element.removeEventListener('pointermove', rememberPointer);
      element.removeEventListener('pointerenter', rememberPointer);
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('gesturestart', start);
      window.removeEventListener('gesturechange', change);
      window.removeEventListener('gestureend', end);
      window.removeEventListener('blur', blur);
    };
  }, [ref, surface]);
}
