import { useEffect, useReducer } from 'react';

/**
 * Re-renders the component every `intervalMs` and returns a fresh value from `read`.
 * Panels use it instead of subscribing to the message stream, so React renders a few
 * times per second no matter how many messages arrive. The value is read on every render,
 * so a component that changes the store can call the returned `refresh` to show it at once.
 */
export function usePoll<T>(read: () => T, intervalMs = 250): T {
  return usePollWithRefresh(read, intervalMs)[0];
}

export function usePollWithRefresh<T>(read: () => T, intervalMs = 250): [T, () => void] {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return [read(), refresh];
}
