import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Context, Logger } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ToolActivationContext, ToolDefinition, ToolRegistrationOptions } from "@deepseek-ai/dsh-tools";
import type { Tracker } from "../src/plugin/tracker.ts";
import type { Config } from "../src/plugin/bundle.ts";
import { importIdentity } from "../src/plugin/stores.ts";

const trackers: Tracker[] = [];
/** The pod each captured tracker follows: the one `apply` composed. */
const pods: ConstructorParameters<typeof Tracker>[0][] = [];
/** The session lookup each captured tracker was given. */
const resolvers: ConstructorParameters<typeof Tracker>[2][] = [];

// Capture the tracker `apply` composes so the test can observe how it is wired.
vi.mock("../src/plugin/tracker.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/plugin/tracker.ts")>();
  class CapturingTracker extends original.Tracker {
    constructor(...args: ConstructorParameters<typeof original.Tracker>) {
      super(...args);
      trackers.push(this);
      pods.push(args[0]);
      resolvers.push(args[2]);
    }
  }
  return { ...original, Tracker: CapturingTracker };
});

const { apply } = await import("../src/plugin/bundle.ts");
const { PodStores, NODE_KEY, PASSWORD_REF } = await import("../src/plugin/stores.ts");

const roots: string[] = [];

afterEach(async () => {
  trackers.length = 0;
  pods.length = 0;
  resolvers.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Cleanup = () => void;

/** Event payloads the fake replays; the plugin only reads these fields. */
interface FakeClaim {
  agent: { id: string };
  message: { source?: { kind?: string } };
  turn: number;
}

interface RegisteredTool {
  definition: ToolDefinition;
  options?: ToolRegistrationOptions;
}

/** The host services `apply` registers into; the fake implements only these. */
interface FakeServices {
  tools: { register(definition: ToolDefinition, options?: ToolRegistrationOptions): Cleanup | undefined };
  webServer: { register(route: WebRoute): Cleanup };
  agents: { get(id: string): unknown };
  sandboxPolicy: { resolve(request: { session?: unknown }): Record<string, unknown> };
  llm: { listProviders(): never[]; listModels(provider: string): Promise<never[]> };
  agentDefaultModel: { currentSelection(): Record<string, unknown> };
  skills: { register(skill: { name: string }): Cleanup };
  settings: { configure(presentation: { auto?: boolean }): Cleanup };
}

/** The `Context` slice the plugin reads, with the fake's callbacks typed. */
interface FakeCtx {
  /** Cordis service lookup; nothing is provided here, so `launchEnvironmentOf` falls back to the process layer. */
  get(name: string): undefined;
  tools: FakeServices["tools"];
  credentials: {
    resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
    describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
    set(ref: string, value: string): Promise<void>;
    unset(ref: string): Promise<void>;
    readRecord(key: string): Promise<FakeRecord | undefined>;
    modifyRecord(
      key: string,
      mutate: (current: FakeRecord | undefined) => Promise<FakeRecord | undefined>,
    ): Promise<FakeRecord | undefined>;
    deleteRecord(key: string): Promise<void>;
  };
  /** The DSH home the host resolved; the plugin keeps its data under it. */
  dshHomePath(): string;
  logger: LoggerService;
  fiber: { effect(execute: () => Cleanup): unknown };
  effect(execute: () => Cleanup): Cleanup | undefined;
  on(event: string, listener: (payload: never) => void): undefined;
  inject(dependencies: readonly string[], callback: (scope: FakeCtx) => void): undefined;
}

/** A stored credential record: the plugin only keeps a grant with its payload in it. */
type FakeRecord = { kind: "grant"; payload: unknown };

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** `ctx.logger` is itself callable; the scope logger it returns carries the level methods. */
type LoggerService = Logger & ((name?: string) => Logger);

function fakeHost(dshHome: string) {
  const tools: RegisteredTool[] = [];
  const routes: WebRoute[] = [];
  const disposers: Cleanup[] = [];
  const claims: Array<(payload: FakeClaim) => void> = [];
  const credentialListeners: Array<{ event: string; listener: (subject: string) => void }> = [];
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
  const records = new Map<string, FakeRecord>();
  let recordLock: Promise<void> = Promise.resolve();

  const ctx: FakeCtx = {
    get: () => undefined,
    tools: services.tools,
    credentials: {
      resolve: async (ref) => {
        const value = secrets.get(ref);
        return value === undefined ? undefined : { value, source: "file" };
      },
      set: async (ref, value) => {
        secrets.set(ref, value);
      },
      describe: async (ref) => ({ configured: secrets.has(ref), writable: true }),
      unset: async (ref) => {
        secrets.delete(ref);
      },
      readRecord: async (key) => records.get(key),
      // Like the real store, the write is exclusive: `mutate` sees the record as it stands.
      modifyRecord: (key, mutate) => {
        const done = recordLock.then(async () => {
          const next = await mutate(records.get(key));
          if (next !== undefined) records.set(key, next);
          return records.get(key);
        });
        recordLock = done.then(
          () => undefined,
          () => undefined,
        );
        return done;
      },
      deleteRecord: async (key) => {
        records.delete(key);
      },
    },
    dshHomePath: () => dshHome,
    logger: Object.assign(() => noopLogger, noopLogger) as unknown as LoggerService,
    fiber: { effect: () => undefined },
    effect(execute) {
      disposers.push(execute());
      return undefined;
    },
    on(event, listener) {
      if (event === "agent/inbox/claimed") claims.push(listener as unknown as (payload: FakeClaim) => void);
      else credentialListeners.push({ event, listener: listener as unknown as (subject: string) => void });
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
    skills,
    configured,
    scopes,
    replace,
    secrets,
    records,
    /** Tell the plugin the credential store changed, the way the host does. */
    emitCredentialEvent: (event: string, subject: string): void => {
      for (const entry of credentialListeners) if (entry.event === event) entry.listener(subject);
    },
    credentialEvents: () => credentialListeners.map(({ event }) => event),
  };
}

/**
 * Apply the plugin on a fake host whose DSH home is a fresh directory. `settings`
 * are what the machine's settings file holds; `password` what the credential
 * store holds.
 */
async function applied(
  options: { config?: Partial<Config>; settings?: Record<string, unknown>; password?: string } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "orca-apply-"));
  roots.push(home);
  const host = fakeHost(home);
  if (options.password !== undefined) host.secrets.set(PASSWORD_REF, options.password);
  if (options.settings !== undefined) {
    await mkdir(join(home, "orca-pod"), { recursive: true });
    await writeFile(join(home, "orca-pod", "settings.json"), JSON.stringify(options.settings));
  }
  apply(host.ctx as unknown as Context, { skill_injection: false, ...options.config });
  return host;
}

describe("plugin apply", () => {
  it("composes the tool, the panel route, the settings policy and one unload disposer", async () => {
    const host = await applied();
    expect(host.tools.map((entry) => entry.definition.name)).toEqual(["orca_pod"]);
    expect(host.routes).toHaveLength(1);
    expect(host.claims).toHaveLength(1);
    expect(host.configured).toEqual([{ auto: false }]);
    // The plugin itself owns only the pod; the panel route and the
    // settings-page policy live in their own inject scopes.
    expect(host.disposers).toHaveLength(1);
    // agents, permission presets, panel route, settings page, llm, default model.
    expect(host.scopes.flatMap((scope) => scope.cleanups)).toHaveLength(6);
    for (const dispose of host.disposers) await dispose();
  });

  it("starts the tracker at once, and finds sessions through the host's registry", async () => {
    const start = vi.spyOn((await import("../src/plugin/tracker.ts")).Tracker.prototype, "start");
    try {
      const host = await applied();
      expect(start).toHaveBeenCalledOnce();
      const agent = { id: "live-session" };
      host.services.agents.get = (id) => (id === "live-session" ? agent : undefined);
      expect(resolvers[0]!("live-session" as never)).toBe(agent);
      expect(resolvers[0]!("other" as never)).toBeUndefined();
      for (const dispose of host.disposers) await dispose();
    } finally {
      start.mockRestore();
    }
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

  it("registers the bundled skill through ctx.skills when requested", async () => {
    const host = await applied({ config: { skill_injection: true } });
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
    const host = await applied({ config: { skill_injection: true } });
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

  it("restarts the node once when the panel changes the password, though the store reports the write back", async () => {
    const host = await applied({ settings: { workgroup_id: "wg-a", port: 0 }, password: "old" });
    // Like the host's store, a write is reported to the plugin as a change of that reference.
    const { set } = host.ctx.credentials;
    host.ctx.credentials.set = async (ref, value) => {
      await set(ref, value);
      host.emitCredentialEvent("credentials/reference-updated", ref);
    };
    const pod = pods[0]!;
    await pod.orca();
    const { Orca } = await import("../src/node/orca.ts");
    const starts = vi.spyOn(Orca.prototype, "start");
    try {
      await pod.reconfigure({ workgroup_password: "new" });
      await pod.orca();
      expect(starts).toHaveBeenCalledTimes(1);
    } finally {
      starts.mockRestore();
      for (const dispose of host.disposers) await dispose();
    }
  });

  it("listens for changes to the password and the node key, and for nothing else of the credential store", async () => {
    const host = await applied();
    expect(host.credentialEvents().sort()).toEqual(["credentials/record-updated", "credentials/reference-updated"]);
    // Unrelated credentials are ignored; the pod is not started, so nothing observable happens either way.
    host.emitCredentialEvent("credentials/reference-updated", "DEEPSEEK_API_KEY");
    host.emitCredentialEvent("credentials/record-updated", "llm-pi-ai/deepseek");
    for (const dispose of host.disposers) await dispose();
  });
});

describe("pod stores on the DSH credential store", () => {
  const storesOf = (host: ReturnType<typeof fakeHost>) =>
    new PodStores(host.ctx as unknown as ConstructorParameters<typeof PodStores>[0]);

  it("keeps the password under one machine-wide reference", async () => {
    const host = fakeHost("/dsh-home");
    const stores = storesOf(host);
    expect(await stores.readPassword()).toBeUndefined();

    await stores.writePassword("secret");
    expect(host.secrets.get("ORCA_POD_PASSWORD")).toBe("secret");
    expect(await stores.readPassword()).toBe("secret");

    await stores.clearPassword();
    expect(await stores.readPassword()).toBeUndefined();
  });

  it("makes the node key once, as a base58 Ed25519 seed in a grant record, and returns the same node afterwards", async () => {
    const host = fakeHost("/dsh-home");
    const stores = storesOf(host);
    expect(await stores.readIdentity()).toBeUndefined();

    const made = await stores.identity();
    const record = host.records.get(NODE_KEY);
    expect(record).toMatchObject({ kind: "grant", payload: { ed25519: expect.any(String) } });
    const stored = record?.payload as { ed25519: string };
    expect(importIdentity(stored.ed25519).orcaNodeId).toBe(made.orcaNodeId);

    expect((await stores.identity()).orcaNodeId).toBe(made.orcaNodeId);
    expect((await stores.readIdentity())?.orcaNodeId).toBe(made.orcaNodeId);
  });

  it("gives processes that ask together the same node key", async () => {
    const host = fakeHost("/dsh-home");
    // The fake serializes `modifyRecord` the way the real store's lock does.
    const ids = await Promise.all(Array.from({ length: 5 }, async () => (await storesOf(host).identity()).orcaNodeId));
    expect(new Set(ids).size).toBe(1);
  });

  it("refuses a damaged node key instead of silently making another node", async () => {
    const host = fakeHost("/dsh-home");
    host.records.set(NODE_KEY, { kind: "grant", payload: { ed25519: "not*base58" } });
    await expect(storesOf(host).identity()).rejects.toThrow(/damaged/);
    host.records.set(NODE_KEY, { kind: "grant", payload: { other: 1 } });
    await expect(storesOf(host).identity()).rejects.toThrow(/not an Ed25519 key/);
    // Nothing overwrote it: the owner can still restore or delete it.
    expect(host.records.get(NODE_KEY)?.payload).toEqual({ other: 1 });
  });

  it("deletes the node key", async () => {
    const host = fakeHost("/dsh-home");
    const stores = storesOf(host);
    await stores.identity();
    await stores.deleteIdentity();
    expect(await stores.readIdentity()).toBeUndefined();
  });
});
