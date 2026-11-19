/** The one shared snapshot of `/orca-api/state`, its poll timer and the action helper. */

import { errorMessage } from "../src/core/errors.ts";
import React from "react";
import { POLL_MS } from "./constants.ts";
import type { LocaleService, PodActions, PodReads, PodState } from "./types.ts";

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

/** One `/orca-api` call (a POST when it carries a body): the JSON answer, or the host's `error` text thrown. */
async function call(path: string, post?: { body: unknown }): Promise<unknown> {
  const init: RequestInit =
    post === undefined
      ? { headers: { "x-orca-pod": "1" } }
      : {
          method: "POST",
          headers: { "x-orca-pod": "1", "content-type": "application/json" },
          body: JSON.stringify(post.body),
        };
  const response = await fetch(`/orca-api/${path}`, init);
  const data = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(data.error);
  return data;
}

/** GET one panel route; the route name fixes both the query it takes and the shape it answers with. */
export async function read<K extends keyof PodReads>(
  route: K,
  query: PodReads[K]["query"],
): Promise<PodReads[K]["response"]> {
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
  return (await call(search ? `${route}?${search}` : route)) as PodReads[K]["response"];
}

/**
 * Save a file a member published (§5.6). It comes through this node's bridge,
 * which needs the panel header, so a plain link cannot fetch it: the bytes are
 * read here and handed to the browser through a detached download link.
 */
export async function downloadBlob(node: string, blob: string, name: string): Promise<void> {
  const query = new URLSearchParams({ node, blob }).toString();
  const response = await fetch(`/orca-api/blob?${query}`, { headers: { "x-orca-pod": "1" } });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
/**
 * The one shared snapshot every slot component reads. A single timer polls
 * `/state` while anything is subscribed and stops with the last subscriber;
 * an action refreshes the snapshot for everyone, and an unchanged payload
 * leaves it (and every component) untouched.
 */
function createStore() {
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
      const next = await read("state", {});
      polledAt = Date.now();
      const text = JSON.stringify(next);
      if (text !== payload) {
        payload = text;
        set({ state: next, error: null });
      } else if (snap.error !== null) {
        set({ error: null });
      }
    } catch (err) {
      if (snap.error !== errorMessage(err)) set({ error: errorMessage(err) });
    }
  }
  /** POST one action and refresh; resolves false (error kept in `actionError`) when the host refused. */
  async function act<K extends keyof PodActions>(path: K, body: PodActions[K]): Promise<boolean> {
    set({ busy: true, actionError: null });
    try {
      await call(path, { body });
      await refresh();
      return true;
    } catch (err) {
      set({ actionError: errorMessage(err) });
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
/** What `useRead` holds: the answer once it arrived, or why it did not. */
type ReadResult<T> = { data: T | null; error: string | null };

/** Read one panel route on mount, and again when the query or `version` changes. */
export function useRead<K extends keyof PodReads>(
  route: K,
  query: PodReads[K]["query"],
  version = 0,
): ReadResult<PodReads[K]["response"]> {
  const [result, setResult] = React.useState<ReadResult<PodReads[K]["response"]>>({ data: null, error: null });
  const key = JSON.stringify(query);
  // The effect depends on `key`, not `query`: callers build a new query object on every render.
  React.useEffect(() => {
    let live = true;
    read(route, query).then(
      (data) => live && setResult({ data, error: null }),
      (err) => live && setResult({ data: null, error: errorMessage(err) }),
    );
    return () => {
      live = false;
    };
  }, [route, key, version]);
  return result;
}
