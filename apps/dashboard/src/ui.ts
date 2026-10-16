import { useCallback, useEffect, useState } from 'react';

const read = () => location.hash.replace(/^#/, '') || '/';

export function usePath(): string {
  const [path, setPath] = useState(read);
  useEffect(() => {
    const on = () => setPath(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return path;
}

export const navigate = (path: string) => {
  location.hash = path;
};

export type Load<T> = { data: T | undefined; error: string | undefined; reload: () => void };

/** Runs `fn` on mount and whenever `reload()` is called. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): Load<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);
  // fn is a fresh closure every render; deps say when it is actually different.
  const run = useCallback(fn, deps);

  useEffect(() => {
    let live = true;
    run().then(
      (d) => live && (setData(d), setError(undefined)),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [run, nonce]);

  return { data, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export const fmtTime = (iso: string) => new Date(iso).toLocaleString();
