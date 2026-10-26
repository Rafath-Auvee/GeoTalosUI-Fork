'use client';

import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { useInteractiveStore } from './store';

/**
 * While Interactive annotation mode is on, the rest of the editor (top bar,
 * layers panel) must not be clickable or focusable — the only way out is the
 * mode's Exit. Attach `ref` + `style` to the element to lock.
 */
export function useModeLock<T extends HTMLElement>(): { ref: RefObject<T | null>; locked: boolean; style: CSSProperties } {
  const locked = useInteractiveStore((s) => s.active);
  const ref = useRef<T | null>(null);
  useEffect(() => {
    // `inert` removes the subtree from pointer and keyboard interaction (React 18 has no prop for it).
    if (ref.current) (ref.current as HTMLElement & { inert: boolean }).inert = locked;
  }, [locked]);
  return {
    ref,
    locked,
    style: locked ? { pointerEvents: 'none', opacity: 0.45, filter: 'grayscale(0.6)', transition: 'opacity 0.15s' } : {},
  };
}
