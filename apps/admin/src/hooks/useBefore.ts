import { useEffect, useState } from 'react';

/**
 * `true` mientras falte para `deadlineMs` (marca de tiempo en ms); `null` = sin plazo.
 * Se vuelve a renderizar solo cuando el plazo vence, sin sondeos.
 */
export function useBefore(deadlineMs: number | null): boolean {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (deadlineMs === null) return;
    const wait = deadlineMs - Date.now();
    if (wait <= 0) return;
    const id = window.setTimeout(() => setTick((t) => t + 1), wait + 50);
    return () => window.clearTimeout(id);
  }, [deadlineMs]);
  return deadlineMs !== null && Date.now() < deadlineMs;
}
