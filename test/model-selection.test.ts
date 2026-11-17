import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { ModelOffersSchema, parseModelSelection } from "../src/protocol/model.ts";
import { parseSchema } from "../src/kernel/schema.ts";
import type { Settings } from "../src/node/settings.ts";
import { discoverModelCatalog } from "../src/plugin/catalog.ts";
import { createOrcaNode, createPersistentStorage, type OrcaNode } from "../src/node/orca-node.ts";

const LIVE: OrcaNode[] = [];
const ROOTS: string[] = [];

afterEach(async () => {
  for (const node of LIVE.splice(0)) await node.stop();
  for (const root of ROOTS.splice(0)) await rm(root, { recursive: true, force: true });
});

async function startNode(options: Partial<Settings>): Promise<OrcaNode> {
  const root = await mkdtemp(join(tmpdir(), "orca-model-"));
  ROOTS.push(root);
  const config = createOrcaNodeConfig({
    workgroup_id: "model-test",
    workgroup_password: "correct horse",
    data_root: root,
    port: 0,
    ...options,
  });
  const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
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

describe("model catalog", () => {
  it("validates offers and selections", () => {
    expect(offers([{ provider: "deepseek", model: "deepseek-flash" }])).toHaveLength(1);
    expect(typeof offers([{ provider: "", model: "x" }])).toBe("string");
    expect(typeof offers([{ provider: "p" }])).toBe("string");
    expect(typeof offers(Array.from({ length: 129 }, () => ({ provider: "p", model: "m" })))).toBe("string");
    expect(parseModelSelection({ provider: "p", model: "m", reasoning_effort: "high" })).toEqual({
      provider: "p",
      model: "m",
      reasoning_effort: "high",
    });
    expect(parseModelSelection({ provider: "p" })).toBeNull();
    expect(parseModelSelection({ provider: "p", model: "m", reasoning_effort: "" })).toBeNull();
    // One blank-effort rule for the selection and for the standalone value.
    expect(parseModelSelection({ provider: "p", model: "m", reasoning_effort: "  " })).toBeNull();
    expect(
      offers([
        { provider: "p", model: "m" },
        { provider: "p", model: "" },
      ]),
    ).toMatch(/^1\.model /);
  });

  it("drops unknown keys from a copy instead of rejecting them", () => {
    const raw = { provider: "p", model: "m", tier: "gold" };
    expect(parseModelSelection(raw)).toEqual({ provider: "p", model: "m" });
    expect(raw).toHaveProperty("tier", "gold");
    expect(offers([{ provider: "p", model: "m", name: "M", extra: 1 }])).toEqual([
      { provider: "p", model: "m", name: "M" },
    ]);
    expect(parseModelSelection("p/m")).toBeNull();
    expect(parseModelSelection(null)).toBeNull();
    const configured = createOrcaNodeConfig({
      workgroup_id: "wg",
      workgroup_password: "pw",
      data_root: join(tmpdir(), "orca-model-config"),
      default_reasoning_effort: "max",
    });
    expect(configured.default_reasoning_effort).toBe("max");
    expect(() =>
      createOrcaNodeConfig({
        workgroup_id: "wg",
        workgroup_password: "pw",
        data_root: join(tmpdir(), "orca-model-config"),
        default_reasoning_effort: "",
      }),
    ).toThrow();
  });

  it("advertises the catalog on join and in the peer directory", async () => {
    const models = [
      { provider: "deepseek", model: "deepseek-flash", name: "Flash" },
      { provider: "deepseek", model: "deepseek-v4-pro", name: "Pro" },
    ];
    const a = await startNode({ models });
    const b = await startNode({
      models: [{ provider: "deepseek", model: "deepseek-flash" }],
      default_model: { provider: "deepseek", model: "deepseek-flash" },
      default_reasoning_effort: "max",
    });
    await b.join(a.endpoints[0]!);
    const peer = await until(() => a.members().find((member) => member.orca_node_id === b.orcaNodeId) ?? null);
    expect(peer.models).toHaveLength(1);
    expect(peer.models?.[0]).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
    expect(peer.default_model).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(peer.default_reasoning_effort).toBe("max");
    // The join response carries the directory, so b sees a's catalog too.
    const seenByB = await until(() => b.members().find((member) => member.orca_node_id === a.orcaNodeId) ?? null);
    expect(seenByB.models).toHaveLength(2);
    expect(seenByB.default_reasoning_effort).toBeNull();
  });

  it("fails a task that asks for a model when the executor cannot select one", async () => {
    const node = await startNode({});
    const submitted = await node.sendTask(node.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "select a model" }] },
      metadata: { pod: { model: { provider: "deepseek", model: "deepseek-flash" } } },
    });
    const deadline = Date.now() + 5_000;
    let task = await node.getTask(node.endpoints[0]!, submitted.id);
    while (task.status.state !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      task = await node.getTask(node.endpoints[0]!, submitted.id);
    }
    expect(task.status.state).toBe("failed");
    expect(task.status.reason).toBe("model_unsupported");
  });

  it("fails a task that asks for a reasoning effort when the executor cannot select one", async () => {
    const node = await startNode({});
    const submitted = await node.sendTask(node.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "select an effort" }] },
      metadata: { pod: { reasoning_effort: "max" } },
    });
    const deadline = Date.now() + 5_000;
    let task = await node.getTask(node.endpoints[0]!, submitted.id);
    while (task.status.state !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      task = await node.getTask(node.endpoints[0]!, submitted.id);
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
            { id: "deepseek-flash", name: "Flash", description: "fast" },
            { id: "deepseek-v4-pro", name: "Pro" },
          ];
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "deepseek-flash" }) },
    };
    const catalog = await discoverModelCatalog(services, { info() {}, warn() {}, error() {} });
    expect(catalog.models.map((model) => model.model)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(catalog.models[0]?.description).toBe("fast");
    expect(catalog.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });
});
