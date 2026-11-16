import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostContext, InboxClaimed, ToolDefinition, WebServerRoute } from "../src/plugin/dsh.ts";
import type { Tracker } from "../src/plugin/tracker.ts";
import { parseSettings } from "../src/settings.ts";

const trackers: Tracker[] = [];

// Capture the tracker `apply` composes so the test can observe wake-budget resets.
vi.mock("../src/plugin/tracker.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/plugin/tracker.ts")>();
  return {
    ...original,
    createTracker: (...args: Parameters<typeof original.createTracker>) => {
      const tracker = original.createTracker(...args);
      trackers.push(tracker);
      return tracker;
    },
  };
});

const { apply } = await import("../src/plugin/index.ts");

const roots: string[] = [];

afterEach(async () => {
  trackers.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fakeHost() {
  const tools: ToolDefinition[] = [];
  const routes: WebServerRoute[] = [];
  const disposers: Array<() => void | Promise<void>> = [];
  const listeners: Array<(payload: InboxClaimed) => void> = [];
  const ctx: HostContext = {
    tools: { register: (tool) => tools.push(tool) },
    logger: { info() {}, warn() {}, error() {} },
    effect(execute) {
      disposers.push(execute());
      return undefined;
    },
    on(_event, listener) {
      listeners.push(listener);
      return undefined;
    },
    inject(_dependencies, callback) {
      callback({
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
      });
    },
    get: () => undefined,
  };
  return { ctx, tools, routes, disposers, listeners };
}

async function applied() {
  const root = await mkdtemp(join(tmpdir(), "orca-apply-"));
  roots.push(root);
  const host = fakeHost();
  apply(host.ctx, parseSettings({ data_root: root }));
  return host;
}

describe("plugin apply", () => {
  it("composes the tool, the panel route and one unload disposer", async () => {
    const host = await applied();
    expect(host.tools.map((tool) => tool.name)).toEqual(["orca_pod"]);
    expect(host.routes).toHaveLength(1);
    expect(host.listeners).toHaveLength(1);
    // One effect for the node lifecycle, one for the panel route.
    expect(host.disposers).toHaveLength(2);
    for (const dispose of host.disposers) await dispose();
  });

  it("resets the wake budget only when the user sends the agent a message", async () => {
    const host = await applied();
    const reset = vi.spyOn(trackers[0]!, "resetWakes");
    const claim = host.listeners[0]!;
    const agent = { id: "agent-1" };

    claim({ agent, message: { source: { kind: "orca-pod" } }, turn: 1 });
    claim({ agent, message: {}, turn: 1 });
    expect(reset).not.toHaveBeenCalled();

    claim({ agent, message: { source: { kind: "user" } }, turn: 2 });
    expect(reset).toHaveBeenCalledExactlyOnceWith("agent-1");
    for (const dispose of host.disposers) await dispose();
  });
});
