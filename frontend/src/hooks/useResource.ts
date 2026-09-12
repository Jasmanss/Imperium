"use client";

import { useEffect, useEffectEvent, useState } from "react";

export interface Resource<T> {
  /** The latest loaded value, kept while a newer key loads. */
  data: T | undefined;
  /** The key data was loaded for. */
  dataKey: string | null;
  error: unknown;
  loading: boolean;
}

interface Loaded<T> {
  key: string | null;
  data: T | undefined;
  dataKey: string | null;
  error: unknown;
}

/**
 * Load a value for a key, reloading whenever the key changes and aborting the
 * previous request. Pass null to load nothing.
 */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ key: null, data: undefined, dataKey: null, error: null });
  const run = useEffectEvent(load);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    run(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setLoaded({ key, data, dataKey: key, error: null });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoaded((previous) => ({ ...previous, key, error }));
      },
    );
    return () => controller.abort();
  }, [key]);

  return {
    data: loaded.data,
    dataKey: loaded.dataKey,
    error: loaded.key === key ? loaded.error : null,
    loading: key !== null && loaded.key !== key,
  };
}
