import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Context, Logger } from "@deepseek-ai/cordis";
import type { Entry } from "@deepseek-ai/cordis-plugin-loader";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ToolActivationContext, ToolDefinition, ToolRegistrationOptions } from "@deepseek-ai/dsh-tools";
import type { Tracker } from "../src/plugin/tracker.ts";
import { parseSettings, type Settings } from "../src/node/settings.ts";
import { wg } from "./fixtures/ids.ts";

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

const { apply } = await import("../src/plugin/bundle.ts");
const { createHostStores } = await import("../src/plugin/stores.ts");

const roots: string[] = [];

afterEach(async () => {
  trackers.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Cleanup = () => void;

/** Event payloads the fake replays; the plugin only reads these fields. */
interface FakeClaim {
  agent: { id: string };
  message: { source?: { kind?: string } };
  turn: number;
}

interface FakeCreated {
  agent: {
    id: string;
    status: "idle" | "running";
    inject(message: unknown): void;
    followup(message: unknown): void;
    ctx: { effect(execute: () => Cleanup): unknown };
  };
}

interface RegisteredTool {
  definition: ToolDefinition;
  options?: ToolRegistrationOptions;
}

/** The host services `apply` registers into; the fake implements only these. */
interface FakeServices {
  tools: { register(definition: ToolDefinition, options?: ToolRegistrationOptions): Cleanup | undefined };
  webServer: { register(route: WebRoute): Cleanup };
  agents: { get(id: string): undefined };
  sandboxPolicy: { resolve(request: { session?: unknown }): Record<string, unknown> };
  llm: { listProviders(): never[]; listModels(provider: string): Promise<never[]> };
  agentDefaultModel: { currentSelection(): Record<string, unknown> };
  skills: { register(skill: { name: string }): Cleanup };
  settings: { configure(presentation: { auto?: boolean }): Cleanup };
}

/** The `Context` slice the plugin reads, with the fake's callbacks typed. */
interface FakeCtx {
  tools: FakeServices["tools"];
  credentials: {
    resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
    set(ref: string, value: string): Promise<void>;
    unset(ref: string): Promise<void>;
  };
  configEditor: {
    edit(
      target: Entry,
      change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
    ): Promise<void>;
  };
  logger: LoggerService;
  fiber: { effect(execute: () => Cleanup): unknown; entry: Entry };
  effect(execute: () => Cleanup): Cleanup | undefined;
  on(event: string, listener: (payload: never) => void): undefined;
  inject(dependencies: readonly string[], callback: (scope: FakeCtx) => void): undefined;
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** `ctx.logger` is itself callable; the scope logger it returns carries the level methods. */
type LoggerService = Logger & ((name?: string) => Logger);

function fakeHost() {
  const tools: RegisteredTool[] = [];
  const routes: WebRoute[] = [];
  const disposers: Cleanup[] = [];
  const claims: Array<(payload: FakeClaim) => void> = [];
  const created: Array<(payload: FakeCreated) => void> = [];
  const skills: string[] = [];
  const configured: Array<{ auto?: boolean }> = [];

  const services: FakeServices = {
    tools: {
      register: (definition, options) => {
        tools.push({ definition, options });
        return undefined;
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
    agents: { get: () => undefined },
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write" }) },
    llm: { listProviders: () => [], listModels: async () => [] },
    agentDefaultModel: { currentSelection: () => ({}) },
    skills: {
      register: (skill) => {
        skills.push(skill.name);
        return () => {};
      },
    },
    settings: {
      configure: (presentation) => {
        configured.push(presentation);
        return () => {};
      },
    },
  };

  /** One live `inject` scope: the services it fenced on and its own effects. */
  interface Scope {
    dependencies: readonly string[];
    run: () => void;
    cleanups: Cleanup[];
  }
  const scopes: Scope[] = [];

  const secrets = new Map<string, string>();
  const entry = { id: "orca-pod", options: { id: "orca-pod", config: {} as Record<string, unknown> } };
  const edits: Array<Record<string, unknown>> = [];

  const ctx: FakeCtx = {
    tools: services.tools,
    credentials: {
      resolve: async (ref) => {
        const value = secrets.get(ref);
        return value === undefined ? undefined : { value, source: "file" };
      },
      set: async (ref, value) => {
        secrets.set(ref, value);
      },
      unset: async (ref) => {
        secrets.delete(ref);
      },
    },
    configEditor: {
      async edit(target, change) {
        const next = change(structuredClone((target.options.config ?? {}) as Record<string, unknown>), {});
        edits.push(next);
        entry.options.config = next;
      },
    },
    logger: Object.assign(() => noopLogger, noopLogger) as unknown as LoggerService,
    fiber: { effect: () => undefined, entry: entry as unknown as Entry },
    effect(execute) {
      disposers.push(execute());
      return undefined;
    },
    on(event, listener) {
      if (event === "agent/created") created.push(listener as unknown as (payload: FakeCreated) => void);
      else claims.push(listener as unknown as (payload: FakeClaim) => void);
      return undefined;
    },
    inject(dependencies, callback) {
      const scope: Scope = { dependencies, cleanups: [], run: () => {} };
      const effect = (execute: () => Cleanup): undefined => {
        scope.cleanups.push(execute());
        return undefined;
      };
      scope.run = () => callback({ ...services, effect } as unknown as Parameters<typeof callback>[0]);
      scopes.push(scope);
      scope.run();
      return undefined;
    },
  };

  /** Simulate Cordis replacing one service: dispose the dependent scopes, then re-run them. */
  async function replace(name: keyof FakeServices): Promise<void> {
    for (const scope of scopes) {
      if (!scope.dependencies.includes(name)) continue;
      for (const cleanup of scope.cleanups.splice(0)) await cleanup();
      scope.run();
    }
  }

  return {
    ctx,
    services,
    tools,
    routes,
    disposers,
    claims,
    created,
    skills,
    configured,
    scopes,
    replace,
    secrets,
    entry,
    edits,
  };
}

async function applied(overrides: Partial<Settings> = {}) {
  const root = await mkdtemp(join(tmpdir(), "orca-apply-"));
  roots.push(root);
  const host = fakeHost();
  apply(host.ctx as unknown as Context, parseSettings({ data_root: root, ...overrides }));
  return host;
}

describe("plugin apply", () => {
  it("composes the tool, the panel route, the settings policy and one unload disposer", async () => {
    const host = await applied();
    expect(host.tools.map((entry) => entry.definition.name)).toEqual(["orca_pod"]);
    expect(host.routes).toHaveLength(1);
    expect(host.claims).toHaveLength(1);
    expect(host.created).toHaveLength(1);
    expect(host.configured).toEqual([{ auto: false }]);
    // The plugin itself owns only the node lifecycle; the panel route and the
    // settings-page policy live in their own inject scopes.
    expect(host.disposers).toHaveLength(1);
    // agents, permission presets, panel route, settings page, llm, default model.
    expect(host.scopes.flatMap((scope) => scope.cleanups)).toHaveLength(6);
    for (const dispose of host.disposers) await dispose();
  });

  it("hides the tool until the workgroup credentials exist", async () => {
    const host = await applied();
    const when = host.tools[0]?.options?.when;
    expect(when?.({} as ToolActivationContext)).toBe(false);
    for (const dispose of host.disposers) await dispose();
  });

  it("resets the wake budget only when the user sends the agent a message", async () => {
    const host = await applied();
    const reset = vi.spyOn(trackers[0]!, "resetWakes");
    const claim = host.claims[0]!;
    const agent = { id: "agent-1" };

    claim({ agent, message: { source: { kind: "orca-pod" } }, turn: 1 });
    claim({ agent, message: {}, turn: 1 });
    expect(reset).not.toHaveBeenCalled();

    claim({ agent, message: { source: { kind: "user" } }, turn: 2 });
    expect(reset).toHaveBeenCalledExactlyOnceWith("agent-1");
    for (const dispose of host.disposers) await dispose();
  });

  it("forgets a disposed agent's tracked tasks", async () => {
    const host = await applied();
    const forget = vi.spyOn(trackers[0]!, "forget");
    let disposal: Cleanup | undefined;
    const agent = {
      id: "agent-9",
      status: "idle" as const,
      inject: () => {},
      followup: () => {},
      ctx: {
        effect: (execute: () => Cleanup) => {
          disposal = execute();
        },
      },
    };

    host.created[0]?.({ agent });
    expect(disposal).toBeTypeOf("function");
    disposal?.();
    expect(forget).toHaveBeenCalledExactlyOnceWith("agent-9");
    for (const dispose of host.disposers) await dispose();
  });

  it("registers the bundled skill through ctx.skills when requested", async () => {
    const host = await applied({ skill_injection: true });
    expect(host.skills).toEqual(["orca-node"]);
    for (const dispose of host.disposers) await dispose();
  });

  it("does not fence on the skills service when the skill is not requested", async () => {
    const host = await applied();
    expect(host.scopes.some((scope) => scope.dependencies.includes("skills"))).toBe(false);
    for (const dispose of host.disposers) await dispose();
  });

  it("ties scoped registrations to their inject scope, so a re-run does not stack them", async () => {
    const live = new Set<string>();
    const host = await applied({ skill_injection: true });
    host.services.skills.register = (skill) => {
      live.add(skill.name);
      return () => {
        live.delete(skill.name);
      };
    };
    let pages = 0;
    host.services.settings.configure = () => {
      pages += 1;
      return () => {
        pages -= 1;
      };
    };
    await host.replace("skills");
    await host.replace("settings");
    await host.replace("skills");
    await host.replace("settings");
    expect([...live]).toEqual(["orca-node"]);
    expect(pages).toBe(1);
    for (const dispose of host.disposers) await dispose();
  });

  it("fences on each catalog service separately", async () => {
    const host = await applied();
    const fences = host.scopes.map((scope) => [...scope.dependencies]);
    expect(fences).toContainEqual(["llm"]);
    expect(fences).toContainEqual(["agentDefaultModel"]);
    expect(fences.some((names) => names.length > 1)).toBe(false);
    for (const dispose of host.disposers) await dispose();
  });

  it("keeps the password in the credential store and settings in the profile entry", async () => {
    const host = fakeHost();
    const stores = createHostStores(host.ctx as unknown as Parameters<typeof createHostStores>[0]);
    await stores.writeSecret("ORCA_POD_PASSWORD_WG_A", "secret");
    expect(await stores.readSecret("ORCA_POD_PASSWORD_WG_A")).toBe("secret");
    await stores.clearSecret("ORCA_POD_PASSWORD_WG_A");
    expect(await stores.readSecret("ORCA_POD_PASSWORD_WG_A")).toBeUndefined();

    expect(await stores.writeConfig((raw) => ({ ...raw, workgroup_id: wg("wg-a") }))).toBe(true);
    expect(host.entry.options.config).toEqual({ workgroup_id: "wg-a" });
    // An unchanged config is not written, so the Loader does not restart the plugin.
    expect(await stores.writeConfig((raw) => raw)).toBe(false);
    expect(host.edits).toHaveLength(1);
  });

  it("treats an empty resolved credential as absent", async () => {
    const host = fakeHost();
    host.secrets.set("REF", "");
    expect(
      await createHostStores(host.ctx as unknown as Parameters<typeof createHostStores>[0]).readSecret("REF"),
    ).toBeUndefined();
  });
});
