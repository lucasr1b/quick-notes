"use client";

import { useCallback, useEffect, useState } from "react";

export interface WindowState {
  id: string;
  noteId: string | null;
  viewMode: "rich" | "markdown";
  bounds?: { x?: number; y?: number; width?: number; height?: number } | null;
}

interface ElectronWindowAPI {
  getWindowState: () => Promise<WindowState | null>;
  setWindowState: (partial: Partial<WindowState>) => Promise<WindowState | null>;
  spawnWindow: (opts: {
    initialNote?: string;
    bounds?: { x?: number; y?: number; width?: number; height?: number };
    viewMode?: "rich" | "markdown";
  }) => Promise<string>;
  closeWindow: () => Promise<void>;
  setWindowPosition: (pos: { x: number; y: number }) => Promise<void>;
  getCursorPoint: () => Promise<{ x: number; y: number }>;
  getWindowBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  onNotesUpdated?: (cb: () => void) => () => void;
}

function getAPI(): ElectronWindowAPI | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { electronAPI?: ElectronWindowAPI };
  return w.electronAPI ?? null;
}

export function useWindowState() {
  const [state, setState] = useState<WindowState | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const api = getAPI();
    if (!api) {
      setLoaded(true);
      return;
    }
    api.getWindowState().then((s) => {
      setState(s);
      setLoaded(true);
    });
  }, []);

  const push = useCallback(async (partial: Partial<WindowState>) => {
    const api = getAPI();
    if (!api) return;
    setState((prev) => (prev ? { ...prev, ...partial } : prev));
    await api.setWindowState(partial);
  }, []);

  const setNoteId = useCallback(
    (id: string | null) => push({ noteId: id }),
    [push]
  );
  const setViewMode = useCallback(
    (mode: "rich" | "markdown") => push({ viewMode: mode }),
    [push]
  );

  const spawnWindow = useCallback(
    async (opts: Parameters<ElectronWindowAPI["spawnWindow"]>[0]) => {
      const api = getAPI();
      if (!api) return null;
      return api.spawnWindow(opts);
    },
    []
  );

  const closeWindow = useCallback(async () => {
    const api = getAPI();
    if (!api) return;
    await api.closeWindow();
  }, []);

  return {
    state,
    loaded,
    setNoteId,
    setViewMode,
    spawnWindow,
    closeWindow,
  };
}
