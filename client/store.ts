/** The one shared snapshot of `/orca-api/state`, its poll timer and the action helper. */

import React from "react";
import { POLL_MS } from "./constants.ts";
import type { LocaleService, PodState } from "./types.ts";

/** What every slot component reads. */
export interface Snapshot {
  state: PodState | null;
  /** Last poll failure, cleared by the next successful poll. */
  error: string | null;
  /** Last action failure, cleared when the next action starts. */
  actionError: string | null;
  busy: boolean;
  panelOpen: boolean;
  /** Sessions whose own approval dock is on screen. */
  docked: string[];
}

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { headers: { "x-orca-pod": "1" } }
      : {
          method: "POST",
          headers: { "x-orca-pod": "1", "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const response = await fetch(`/orca-api/${path}`, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error);
  return data;
}
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/**
 * The one shared snapshot every slot component reads. A single timer polls
 * `/state` while anything is subscribed and stops with the last subscriber;
 * an action refreshes the snapshot for everyone, and an unchanged payload
 * leaves it (and every component) untouched.
 */
export function createStore() {
  let snap: Snapshot = { state: null, error: null, actionError: null, busy: false, panelOpen: false, docked: [] };
  let payload = "";
  let polledAt = 0;
  let loop = 0;
  let timer = 0;
  const listeners = new Set<() => void>();
  function set(patch: Partial<Snapshot>): void {
    snap = { ...snap, ...patch };
    for (const listener of listeners) listener();
  }
  async function refresh() {
    try {
      const next = await api<PodState>("state");
      polledAt = Date.now();
      const text = JSON.stringify(next);
      if (text !== payload) {
        payload = text;
        set({ state: next, error: null });
      } else if (snap.error !== null) {
        set({ error: null });
      }
    } catch (err) {
      if (snap.error !== messageOf(err)) set({ error: messageOf(err) });
    }
  }
  /** POST one action and refresh; resolves false (error kept in `actionError`) when the host refused. */
  async function act(path: string, body?: unknown): Promise<boolean> {
    set({ busy: true, actionError: null });
    try {
      await api(path, body);
      await refresh();
      return true;
    } catch (err) {
      set({ actionError: messageOf(err) });
      return false;
    } finally {
      set({ busy: false });
    }
  }
  function start() {
    const id = ++loop;
    (async function tick() {
      await refresh();
      if (id === loop) timer = window.setTimeout(tick, POLL_MS);
    })();
  }
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) start();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        loop += 1;
        window.clearTimeout(timer);
      }
    };
  }
  /** Mark a session as showing its own approval dock, so the popup skips its prompts. */
  function dock(sessionId: string): () => void {
    set({ docked: [...snap.docked, sessionId] });
    return () => set({ docked: snap.docked.filter((id) => id !== sessionId) });
  }
  return {
    /** Client locale service, bound once by `apply`. */
    locale: null as LocaleService | null,
    get: () => snap,
    polledAt: () => polledAt,
    subscribe,
    act,
    dock,
    setPanelOpen: (panelOpen: boolean) => set({ panelOpen }),
  };
}
export const store = createStore();
export const useStore = () => React.useSyncExternalStore(store.subscribe, store.get);
/** Fetch one read-only route on mount (and when `version` changes). */
export function useApi<T>(path: string, version = 0): { data: T | null; error: string | null } {
  const [result, setResult] = React.useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  React.useEffect(() => {
    let live = true;
    api<T>(path).then(
      (data) => live && setResult({ data, error: null }),
      (err) => live && setResult({ data: null, error: messageOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [path, version]);
  return result;
}
