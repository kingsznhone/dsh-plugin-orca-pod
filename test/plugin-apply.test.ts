import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentCreated,
  Cleanup,
  HostContext,
  HostServices,
  InboxClaimed,
  ToolDefinition,
  ToolRegistrationOptions,
  WebServerRoute,
} from "../src/plugin/dsh.ts";
import type { Tracker } from "../src/plugin/tracker.ts";
import { parseSettings, type Settings } from "../src/settings.ts";

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

const { apply, createHostStores } = await import("../src/plugin/index.ts");

const roots: string[] = [];

afterEach(async () => {
  trackers.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface RegisteredTool {
  definition: ToolDefinition;
  options?: ToolRegistrationOptions;
}

function fakeHost() {
  const tools: RegisteredTool[] = [];
  const routes: WebServerRoute[] = [];
  const disposers: Cleanup[] = [];
  const claims: Array<(payload: InboxClaimed) => void> = [];
  const created: Array<(payload: AgentCreated) => void> = [];
  const skills: string[] = [];
  const configured: Array<{ auto?: boolean }> = [];

  const services: HostServices = {
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
    permissionPresets: { permissionState: () => ({}) },
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
    dependencies: readonly (keyof HostServices)[];
    run: () => void;
    cleanups: Cleanup[];
  }
  const scopes: Scope[] = [];

  const secrets = new Map<string, string>();
  const entry = { id: "orca-pod", options: { id: "orca-pod", config: {} as Record<string, unknown> } };
  const edits: Array<Record<string, unknown>> = [];

  const ctx: HostContext = {
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
    logger: { info() {}, warn() {}, error() {} },
    fiber: { effect: () => undefined, entry },
    effect(execute) {
      disposers.push(execute());
      return undefined;
    },
    on(event, listener) {
      if (event === "agent/created") created.push(listener as (payload: AgentCreated) => void);
      else claims.push(listener as (payload: InboxClaimed) => void);
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
  async function replace(name: keyof HostServices): Promise<void> {
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
  apply(host.ctx, parseSettings({ data_root: root, ...overrides }));
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
    expect(when?.({})).toBe(false);
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
    const stores = createHostStores(host.ctx);
    await stores.writeSecret("ORCA_POD_PASSWORD_WG_A", "secret");
    expect(await stores.readSecret("ORCA_POD_PASSWORD_WG_A")).toBe("secret");
    await stores.clearSecret("ORCA_POD_PASSWORD_WG_A");
    expect(await stores.readSecret("ORCA_POD_PASSWORD_WG_A")).toBeUndefined();

    expect(await stores.writeConfig((raw) => ({ ...raw, workgroup_id: "wg-a" }))).toBe(true);
    expect(host.entry.options.config).toEqual({ workgroup_id: "wg-a" });
    // An unchanged config is not written, so the Loader does not restart the plugin.
    expect(await stores.writeConfig((raw) => raw)).toBe(false);
    expect(host.edits).toHaveLength(1);
  });

  it("treats an empty resolved credential as absent", async () => {
    const host = fakeHost();
    host.secrets.set("REF", "");
    expect(await createHostStores(host.ctx).readSecret("REF")).toBeUndefined();
  });
});
