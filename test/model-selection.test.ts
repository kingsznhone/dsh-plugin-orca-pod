import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Context, Logger } from "@deepseek-ai/cordis";

import { nodeParts } from "./support/node.ts";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { ModelOffersSchema, ModelSelectionSchema } from "../src/core/wire/model.ts";
import { parseSchema } from "../src/core/schema.ts";
import type { Settings } from "../src/node/settings.ts";
import { ModelCatalogFeed, type HostModelCatalog } from "../src/plugin/catalog.ts";
import { Pod } from "../src/plugin/pod.ts";
import { MemoryPodStores } from "../src/plugin/stores.ts";
import { Orca } from "../src/node/orca.ts";
import { wg } from "./fixtures/ids.ts";
import { peersOf } from "./support/node.ts";

const LIVE: Orca[] = [];
const ROOTS: string[] = [];

afterEach(async () => {
  for (const node of LIVE.splice(0)) await node.stop();
  for (const root of ROOTS.splice(0)) await rm(root, { recursive: true, force: true });
});

async function startNode(options: Partial<Settings>): Promise<Orca> {
  const root = await mkdtemp(join(tmpdir(), "orca-model-"));
  ROOTS.push(root);
  const config = nodeParts({
    workgroup_id: wg("model-test"),
    workgroup_password: "correct horse",
    data_root: root,
    port: 0,
    ...options,
  });
  const node = new Orca(...config, { persistent: true });
  await node.start();
  LIVE.push(node);
  return node;
}

async function until<T>(check: () => T | null, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The checked value, or the "<path> <reason>" text of the first issue. */
function offers(raw: unknown) {
  const result = parseSchema(ModelOffersSchema, raw);
  return result.ok ? result.value : `${result.issue.path.join(".")} ${result.issue.message}`;
}

/** A checked selection, or null. */
function selection(raw: unknown) {
  const result = parseSchema(ModelSelectionSchema, raw);
  return result.ok ? result.value : null;
}

describe("model catalog", () => {
  it("validates offers and selections", () => {
    expect(offers([{ provider: "deepseek", id: "deepseek-flash", name: "Flash" }])).toHaveLength(1);
    expect(typeof offers([{ provider: "", id: "x", name: "X" }])).toBe("string");
    expect(typeof offers([{ provider: "p" }])).toBe("string");
    expect(typeof offers(Array.from({ length: 129 }, () => ({ provider: "p", id: "m", name: "M" })))).toBe("string");
    // DSH's ModelSelection shape: camelCase `reasoningEffort`.
    expect(selection({ provider: "p", model: "m", reasoningEffort: "high" })).toEqual({
      provider: "p",
      model: "m",
      reasoningEffort: "high",
    });
    expect(selection({ provider: "p" })).toBeNull();
    expect(selection({ provider: "p", model: "m", reasoningEffort: "" })).toBeNull();
    // One blank-effort rule for the selection and for the standalone value.
    expect(selection({ provider: "p", model: "m", reasoningEffort: "  " })).toBeNull();
    expect(
      offers([
        { provider: "p", id: "m", name: "M" },
        { provider: "p", id: "", name: "M" },
      ]),
    ).toMatch(/^1\.id /);
  });

  it("drops unknown keys from a copy instead of rejecting them", async () => {
    const raw = { provider: "p", model: "m", tier: "gold" };
    expect(selection(raw)).toEqual({ provider: "p", model: "m" });
    expect(raw).toHaveProperty("tier", "gold");
    expect(offers([{ provider: "p", id: "m", name: "M", extra: 1 }])).toEqual([{ provider: "p", id: "m", name: "M" }]);
    expect(selection("p/m")).toBeNull();
    expect(selection(null)).toBeNull();
    const [configured] = nodeParts({
      workgroup_id: wg("wg"),
      workgroup_password: "pw",
      data_root: join(tmpdir(), "orca-model-config"),
      default_reasoning_effort: ReasoningEffortId("max"),
    });
    expect(configured.default_reasoning_effort).toBe("max");
    expect(() =>
      nodeParts({
        workgroup_id: wg("wg"),
        workgroup_password: "pw",
        data_root: join(tmpdir(), "orca-model-config"),
        default_reasoning_effort: ReasoningEffortId(""),
      }),
    ).toThrow();
  });

  it("advertises the catalog on join and in the peer directory", async () => {
    const models = [
      { provider: "deepseek", id: "deepseek-flash", name: "Flash" },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "Pro" },
    ];
    const a = await startNode({ models });
    const b = await startNode({
      models: [{ provider: "deepseek", id: "deepseek-flash", name: "Flash" }],
      default_model: { provider: "deepseek", model: "deepseek-flash" },
      default_reasoning_effort: ReasoningEffortId("max"),
    });
    await b.mesh.probe(a.mesh.self.endpoints[0]!);
    const peer = await until(() => peersOf(a).find((member) => member.orca_node_id === b.orcaNodeId) ?? null);
    expect(peer.models).toHaveLength(1);
    expect(peer.models?.[0]).toMatchObject({ provider: "deepseek", id: "deepseek-flash" });
    expect(peer.default_model).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(peer.default_reasoning_effort).toBe("max");
    // The join response carries the directory, so b sees a's catalog too.
    const seenByB = await until(() => peersOf(b).find((member) => member.orca_node_id === a.orcaNodeId) ?? null);
    expect(seenByB.models).toHaveLength(2);
    expect(seenByB.default_reasoning_effort).toBeNull();
  });

  it("fails a task that asks for a model when the executor cannot select one", async () => {
    const node = await startNode({});
    const submitted = await node.mesh.resolve(node.mesh.self.endpoints[0]!).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "select a model" }] },
      metadata: { pod: { model: { provider: "deepseek", model: "deepseek-flash" } } },
    });
    const deadline = Date.now() + 5_000;
    let task = await node.mesh.resolve(node.mesh.self.endpoints[0]!).getTask(submitted.id);
    while (task.status.state !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      task = await node.mesh.resolve(node.mesh.self.endpoints[0]!).getTask(submitted.id);
    }
    expect(task.status.state).toBe("failed");
    expect(task.status.reason).toBe("model_unsupported");
  });

  it("fails a task that asks for a reasoning effort when the executor cannot select one", async () => {
    const node = await startNode({});
    const submitted = await node.mesh.resolve(node.mesh.self.endpoints[0]!).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "select an effort" }] },
      metadata: { pod: { reasoning_effort: ReasoningEffortId("max") } },
    });
    const deadline = Date.now() + 5_000;
    let task = await node.mesh.resolve(node.mesh.self.endpoints[0]!).getTask(submitted.id);
    while (task.status.state !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      task = await node.mesh.resolve(node.mesh.self.endpoints[0]!).getTask(submitted.id);
    }
    expect(task.status.state).toBe("failed");
    expect(task.status.reason).toBe("model_unsupported");
  });

  it("discovers the catalog from the DSH host services", async () => {
    const services = {
      llm: {
        listProviders: () => [
          { id: "deepseek", name: "DeepSeek" },
          { id: "broken", name: "Broken" },
        ],
        listModels: async (provider: string) => {
          if (provider === "broken") throw new Error("no adapter");
          return [
            { provider, id: "deepseek-flash", name: "Flash", description: "fast" },
            { provider, id: "deepseek-v4-pro", name: "Pro" },
          ];
        },
        resolveModelInfo: async (provider: string, id: string) => ({
          provider,
          id,
          name: "Flash",
          reasoning: {
            efforts: [
              { id: "high", name: "High" },
              { id: "max", name: "Max" },
            ],
          },
        }),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "deepseek-flash" }) },
    };
    // A host that offers both services the moment the feed asks for them.
    const ctx = {
      inject: (keys: string[], scope: (scope: unknown) => void) => {
        const [key] = keys;
        scope({ [key!]: services[key as keyof typeof services], effect: () => {} });
      },
    } as unknown as Pick<Context, "inject">;
    const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
    const feed = new ModelCatalogFeed(ctx, logger);
    const told: HostModelCatalog[] = [];
    feed.changes.subscribe(() => told.push(feed.current()));
    await vi.waitFor(() => expect(feed.current().models).toHaveLength(2));
    // Whoever follows the feed is told when a catalog arrived, and reads it from the feed.
    expect(told.length).toBeGreaterThan(0);
    expect(told.at(-1)).toBe(feed.current());
    const catalog = feed.current();
    expect(catalog.models.map((model) => model.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(catalog.models[0]?.description).toBe("fast");
    expect(catalog.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    // The panel offers the efforts the host's default model reports, not a list of its own.
    expect(catalog.reasoningEfforts.map((effort) => effort.id)).toEqual(["high", "max"]);
  });

  it("installs the host's catalog on every node the pod runs and on every later change", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-catalog-"));
    ROOTS.push(root);
    const services = {
      llm: {
        listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
        listModels: async (provider: string) => [{ provider, id: "deepseek-flash", name: "Flash" }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "high", name: "High" }] } }),
      },
    };
    const ctx = {
      inject: (keys: string[], scope: (scope: unknown) => void) => {
        const [key] = keys;
        if (key === "llm") scope({ llm: services.llm, effect: () => {} });
      },
    } as unknown as Pick<Context, "inject">;
    const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
    const stores = new MemoryPodStores({ password: "pw" });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "settings.json"), JSON.stringify({ workgroup_id: wg("wg-catalog"), port: 0 }));
    const feed = new ModelCatalogFeed(ctx, logger);
    await feed.refresh();
    const pod = new Pod(logger, stores, feed, root);
    pod.start();
    try {
      await pod.settled();
      const first = pod.requireRun().orca;
      expect(first.models.offers().map((offer) => offer.id)).toEqual(["deepseek-flash"]);

      // An in-place restart makes a new node, which gets the catalog as well.
      await pod.reconfigure({ workgroup_password: "rotated" });
      const second = pod.requireRun().orca;
      expect(second).not.toBe(first);
      expect(second.models.offers().map((offer) => offer.id)).toEqual(["deepseek-flash"]);

      // A later change in the host reaches the running node through the feed alone.
      services.llm.listModels = async (provider: string) => [
        { provider, id: "deepseek-flash", name: "Flash" },
        { provider, id: "deepseek-v4-pro", name: "Pro" },
      ];
      await feed.refresh();
      expect(second.models.offers().map((offer) => offer.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    } finally {
      await pod.stop();
    }
  });
});
