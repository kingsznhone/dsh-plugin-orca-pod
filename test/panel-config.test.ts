/**
 * Panel-driven configuration (§9.2): settings persisted into the plugin config,
 * the workgroup password kept in the credential store, live reconfiguration,
 * peers remembered as runtime state, and the admin read model that never
 * exposes the password.
 */

import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configPath } from "../src/node/config.ts";
import { shortenNodeId } from "../src/core/identity.ts";
import { normalizePeerUrl } from "../src/core/net.ts";
import { PodAdmin } from "../src/plugin/admin.ts";
import { PodLifecycle } from "../src/plugin/lifecycle.ts";
import { MemoryPodStores } from "../src/plugin/stores.ts";
import { PanelPatchSchema, parseSettings } from "../src/node/settings.ts";
import { ApprovalBroker } from "../src/plugin/broker.ts";
import { PodTool } from "../src/plugin/tools.ts";
import { Tracker } from "../src/plugin/tracker.ts";
import { wg } from "./fixtures/ids.ts";
import { catalogFeed, idleLifecycle, logger } from "./fixtures/pod.ts";

const peerStatePath = (root: string): string => join(root, "peers.json");
const roots: string[] = [];
const PASSWORD = "panel-password";
/** Credential reference derived from the default test workgroup `wg-panel`. */
const REF = "ORCA_POD_PASSWORD_WG_PANEL";

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

/** A raw plugin config as the profile would hold it: no password. */
function bundle(root: string, workgroupId = "wg-panel"): Record<string, unknown> {
  return { workgroup_id: workgroupId, display_name: "panel node", port: 0, data_root: root };
}

type Stores = MemoryPodStores;
type Pod = { handle: PodLifecycle; stores: Stores };

/** Start a pod over in-memory stores; `secrets` pre-fill the credential store. */
function launch(raw: Record<string, unknown>, secrets: Record<string, string> = {}, stores?: Stores): Pod {
  const store = stores ?? new MemoryPodStores(raw);
  for (const [ref, value] of Object.entries(secrets)) store.secrets.set(ref, value);
  const handle = new PodLifecycle(parseSettings(store.raw()), logger, store, catalogFeed());
  handle.start();
  return { handle, stores: store };
}

/** Launch and complete the setup the first-run wizard would perform. */
async function started(raw: Record<string, unknown>): Promise<Pod> {
  const pod = launch(raw);
  await pod.handle.ready;
  if (pod.handle.node === null) await pod.handle.reconfigure({ workgroup_password: PASSWORD });
  return pod;
}

function adminFor(handle: PodLifecycle): PodAdmin {
  const broker = new ApprovalBroker(handle);
  return new PodAdmin(handle, new Tracker(handle, broker, logger, { intervalMs: 60_000 }), broker, catalogFeed());
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("panel configuration lifecycle", () => {
  it("waits for the workgroup password, then keeps it in the credential store only", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = launch(bundle(root));
    await handle.ready;
    try {
      // A plugin config that names a workgroup is not enough: without a stored
      // password a fresh install must not listen (§7.1).
      expect(handle.configured).toBe(false);
      expect(handle.error).toBeNull();
      expect(handle.node).toBeNull();

      await handle.reconfigure({ display_name: "renamed node", workgroup_password: PASSWORD });

      expect(handle.configured).toBe(true);
      expect(handle.config.display_name).toBe("renamed node");
      expect(handle.error).toBeNull();
      expect(stores.secrets.get(REF)).toBe(PASSWORD);
      expect(stores.raw()).toMatchObject({ display_name: "renamed node" });
      // Neither the plugin config nor the node config carries the password.
      expect(JSON.stringify(stores.raw())).not.toContain(PASSWORD);
      expect(await readFile(configPath(root), "utf8")).not.toContain(PASSWORD);

      const firstId = handle.node!.orcaNodeId;
      await handle.reconfigure({ display_name: "renamed again" });
      expect(handle.node!.orcaNodeId).toBe(firstId);
    } finally {
      await handle.stop();
    }
  });

  it("starts at once when the credential store already holds the password", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle } = launch(bundle(root), { [REF]: PASSWORD });
    await handle.ready;
    try {
      expect(handle.configured).toBe(true);
      expect(handle.node).not.toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it("rotates the password in place when no setting changes", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = await started(bundle(root));
    try {
      const before = stores.raw();
      await handle.reconfigure({ workgroup_password: "rotated" });
      expect(stores.secrets.get(REF)).toBe("rotated");
      expect(stores.raw()).toEqual(before);
      expect(handle.config.workgroup_password).toBe("rotated");
      expect(handle.node).not.toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it("makes a tool call wait for an in-place restart instead of reporting that nothing runs", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = await started(bundle(root));
    try {
      // Hold the restart at the point where the old node is gone and the new one is not up yet.
      const readSecret = stores.readSecret.bind(stores);
      let reachedBoot!: () => void;
      const reached = new Promise<void>((resolve) => (reachedBoot = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(stores, "readSecret").mockImplementationOnce(async (ref) => {
        reachedBoot();
        await gate;
        return readSecret(ref);
      });
      const rotating = handle.reconfigure({ workgroup_password: "rotated" });
      await reached;

      const broker = new ApprovalBroker(handle);
      const tool = new PodTool(handle, new Tracker(handle, broker, logger, { intervalMs: 60_000 })).definition();
      const call = tool
        .execute({ method: "members" }, { signal: new AbortController().signal } as unknown as ToolRunContext)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      release();
      await rotating;
      const outcome = await call;
      expect(outcome).toHaveProperty("value");
      expect(JSON.stringify((outcome as { value: unknown }).value)).toContain(handle.node!.orcaNodeId);
    } finally {
      await handle.stop();
    }
  });

  it("keeps the lifecycle queue usable after a rejected reconfigure", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle } = await started(bundle(root));
    try {
      await expect(handle.reconfigure({ port: -1 })).rejects.toThrow();
      // The failed operation must not poison the serial lane.
      await handle.reconfigure({ display_name: "recovered" });
      expect(handle.node).not.toBeNull();
      expect(handle.config.display_name).toBe("recovered");
    } finally {
      await handle.stop();
    }
  });

  it("applies a parsed panel patch and lets null clear a configured value", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = await started({ ...bundle(root), task_timeout_s: 90 });
    try {
      // The panel route parses the body first: keys the panel may not edit never reach the handle.
      await handle.reconfigure(PanelPatchSchema.parse({ data_root: "/elsewhere", display_name: "kept" }));
      expect(handle.config.data_root).toBe(root);
      expect(handle.config.task_timeout_s).toBe(90);
      expect(handle.config.display_name).toBe("kept");

      await handle.reconfigure({ task_timeout_s: null });
      expect(handle.config.task_timeout_s).toBeUndefined();
      expect(stores.raw()).not.toHaveProperty("task_timeout_s");
      expect((await readJson(configPath(root))).task_timeout_s).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it("stops instead of starting a node when it is disposed mid-reconfigure", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle } = await started(bundle(root));
    try {
      const reconfiguring = handle.reconfigure({ display_name: "late rename" });
      const stopping = handle.stop();
      await Promise.allSettled([reconfiguring, stopping]);
      // stopPod waits for the queued restart, and that operation must not start
      // a fresh listener after the host disposed the pod.
      expect(handle.node).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it("listens on loopback until the panel picks an interface", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = await started(bundle(root));
    try {
      expect((await readJson(configPath(root))).bind_host).toBe("127.0.0.1");

      const view = await adminFor(handle).saveConfig({ bind_host: "0.0.0.0" });
      expect(view.bind_host).toBe("0.0.0.0");
      expect(stores.raw().bind_host).toBe("0.0.0.0");
      expect((await readJson(configPath(root))).bind_host).toBe("0.0.0.0");
    } finally {
      await handle.stop();
    }
  });

  it("applies advanced connection and timeout controls from the panel", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = await started(bundle(root));
    try {
      const admin = adminFor(handle);
      const view = await admin.saveConfig({
        task_timeout_s: 120,
        approval_timeout_s: 45,
        result_max_bytes: 4096,
        allow_public_peers: true,
        allow_loopback_peers: false,
        permission_mode: "workspace-write",
        default_reasoning_effort: ReasoningEffortId("max"),
        executor: "echo",
      });

      expect(view.advanced).toEqual({
        task_timeout_s: 120,
        approval_timeout_s: 45,
        result_max_bytes: 4096,
        max_workspace_bytes: 5 * 1024 ** 3,
        max_workspace_files: 50_000,
        allow_public_peers: true,
        allow_loopback_peers: false,
        permission_mode: "workspace-write",
        default_reasoning_effort: ReasoningEffortId("max"),
        executor: "echo",
      });
      expect(handle.error).toBeNull();

      expect(stores.raw().task_timeout_s).toBe(120);
      const nodeConfig = await readJson(configPath(root));
      expect(nodeConfig.task_timeout_s).toBe(120);
      expect(nodeConfig.result_max_bytes).toBe(4096);
      expect(nodeConfig.permission_mode).toBe("workspace-write");
      expect(nodeConfig.default_reasoning_effort).toBe("max");
      expect(nodeConfig.executor).toBe("echo");

      // Clearing a field removes it from the plugin config and the node config,
      // so the local default applies again instead of a stale stored value.
      const cleared = await admin.saveConfig({ task_timeout_s: null, default_reasoning_effort: null, executor: null });
      expect(cleared.advanced.task_timeout_s).toBeNull();
      expect(cleared.advanced.default_reasoning_effort).toBeNull();
      expect(cleared.advanced.executor).toBeNull();
      const clearedConfig = await readJson(configPath(root));
      expect(clearedConfig.task_timeout_s).toBeUndefined();
      expect(clearedConfig.default_reasoning_effort).toBeUndefined();
      // Clearing the executor falls back to the plugin default (acp), which is
      // written back so the persisted node config never loses it.
      expect(clearedConfig.executor).toBe("acp");
    } finally {
      await handle.stop();
    }
  });

  it("full reset drops the workgroup, its password and the identity, and returns to the wizard", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = await started(bundle(root));
    try {
      const before = handle.node!.orcaNodeId;
      expect(handle.configured).toBe(true);

      await handle.reset();

      expect(handle.configured).toBe(false);
      expect(handle.error).toBeNull();
      // Reset returns to the wizard: nothing restarts until setup completes.
      expect(handle.node).toBeNull();
      expect(stores.raw()).not.toHaveProperty("workgroup_id");
      expect(stores.secrets.has(REF)).toBe(false);
      await expect(readFile(configPath(root), "utf8")).rejects.toThrow();

      const view = await adminFor(handle).saveConfig({ workgroup_id: wg("wg-panel"), workgroup_password: PASSWORD });
      expect(view.running).toBe(true);
      expect(handle.node!.orcaNodeId).not.toBe(before);
    } finally {
      await handle.stop();
    }
  });

  it("keeps the configuration and the orca node id on the next start", async () => {
    const root = await tempRoot("orca-panel-");
    const first = await started(bundle(root));
    const firstId = first.handle.node!.orcaNodeId;
    await first.handle.stop();

    const second = launch({}, {}, first.stores);
    await second.handle.ready;
    try {
      expect(second.handle.configured).toBe(true);
      expect(second.handle.error).toBeNull();
      expect(second.handle.node!.orcaNodeId).toBe(firstId);
    } finally {
      await second.handle.stop();
    }
  });

  it("remembers a peer joined live as runtime state, not as config", async () => {
    const rootA = await tempRoot("orca-panel-a-");
    const rootB = await tempRoot("orca-panel-b-");
    const a = await started(bundle(rootA));
    const b = await started(bundle(rootB));
    try {
      const peerUrl = b.handle.url!;
      await a.handle.addPeer(peerUrl);
      expect(a.handle.rememberedPeers).toEqual([peerUrl]);
      expect(await readJson(peerStatePath(rootA))).toEqual({ peers: [peerUrl] });
      // Joining a peer must not rewrite the plugin config (that would restart it).
      expect(a.stores.raw()).not.toHaveProperty("peers");
      expect(adminFor(a.handle).config().peers).toEqual([peerUrl]);
    } finally {
      await a.handle.stop();
      await b.handle.stop();
    }
  });

  it("rejoins the remembered peers when the node starts", async () => {
    const rootA = await tempRoot("orca-panel-a-");
    const rootB = await tempRoot("orca-panel-b-");
    const b = await started(bundle(rootB));
    try {
      const peerUrl = b.handle.url!;
      // What an earlier session left behind; startup tries it once without
      // waiting for the operator to click Connect again.
      await mkdir(rootA, { recursive: true });
      await writeFile(peerStatePath(rootA), JSON.stringify({ peers: [peerUrl] }), "utf8");
      const a = await started(bundle(rootA));
      try {
        const want = b.handle.node!.orcaNodeId;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (a.handle.node!.membership.list().some((member) => member.state === "online")) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        expect(a.handle.node!.membership.list().map((member) => member.orca_node_id)).toContain(want);
      } finally {
        await a.handle.stop();
      }
    } finally {
      await b.handle.stop();
    }
  });

  it("does not remember a peer that cannot be joined", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle } = await started(bundle(root));
    try {
      await expect(handle.addPeer("http://127.0.0.1:1")).rejects.toThrow();
      expect(handle.rememberedPeers).toEqual([]);
      await expect(readFile(peerStatePath(root), "utf8")).rejects.toThrow();
    } finally {
      await handle.stop();
    }
  });
});

describe("panel admin configuration", () => {
  it("never exposes the workgroup password", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle } = await started(bundle(root));
    try {
      const view = adminFor(handle).config();
      expect(view).toMatchObject({
        configured: true,
        workgroup_id: "wg-panel",
        password_set: true,
        running: true,
        error: null,
      });
      expect(JSON.stringify(view)).not.toContain(PASSWORD);
    } finally {
      await handle.stop();
    }
  });

  it("switches the workgroup and carries the current password to its credential", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = await started(bundle(root));
    try {
      const firstId = handle.node!.orcaNodeId;

      const view = await adminFor(handle).saveConfig({ workgroup_id: wg("wg-other") });

      expect(view.workgroup_id).toBe("wg-other");
      expect(view.password_set).toBe(true);
      expect(stores.secrets.get("ORCA_POD_PASSWORD_WG_OTHER")).toBe(PASSWORD);
      expect(handle.config.workgroup_password).toBe(PASSWORD);
      expect(handle.node!.orcaNodeId).toBe(firstId);
      expect((await readJson(configPath(root))).workgroup_id).toBe("wg-other");
    } finally {
      await handle.stop();
    }
  });

  it("normalizes peers before joining them", async () => {
    const seen: string[] = [];
    const handle = idleLifecycle({ workgroup_id: "wg-panel", workgroup_password: "pw" });
    vi.spyOn(handle, "addPeer").mockImplementation(async (peer) => {
      seen.push(peer);
    });
    const admin = adminFor(handle);
    await admin.connect("192.168.1.20:11811");
    await admin.connect("http://desk.example.com/");
    expect(seen).toEqual(["http://192.168.1.20:11811", "http://desk.example.com:80"]);
    expect(normalizePeerUrl("10.0.0.2")).toBe("http://10.0.0.2:11811");
    expect(normalizePeerUrl("10.0.0.2:11811")).toBe("http://10.0.0.2:11811");
    expect(normalizePeerUrl("http://10.0.0.2:11811/")).toBe("http://10.0.0.2:11811");
    expect(normalizePeerUrl("https://desk.example.com")).toBe("https://desk.example.com:443");
    expect(normalizePeerUrl("http://desk.example.com")).toBe("http://desk.example.com:80");
    expect(normalizePeerUrl("[fd00::12]")).toBe("http://[fd00::12]:11811");
    expect(normalizePeerUrl("[fd00::12]:11811")).toBe("http://[fd00::12]:11811");
    expect(normalizePeerUrl("fd00::12")).toBe("http://[fd00::12]:11811");
    expect(normalizePeerUrl("http://[fd00::12]:11811")).toBe("http://[fd00::12]:11811");
    expect(() => normalizePeerUrl("")).toThrow(/peer address is required/);
    expect(() => normalizePeerUrl("http://")).toThrow(/must include a host/);
    expect(() => normalizePeerUrl("http://desk.example.com/a2a")).toThrow(/without a path/);
    expect(() => normalizePeerUrl("http://desk.example.com?x=1")).toThrow(/without a path/);
    expect(() => normalizePeerUrl("10.0.0.2:0")).toThrow(/invalid peer port/);
    expect(() => normalizePeerUrl("10.0.0.2:99999")).toThrow(/invalid peer port/);
    expect(() => normalizePeerUrl("10.0.0.2:abc")).toThrow(/invalid peer port/);
  });

  it("defaults the display name to the orca node id and suggests local endpoints", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle } = await started({ workgroup_id: "wg-id", port: 0, data_root: root });
    try {
      const admin = adminFor(handle);
      const self = admin.self()!;
      expect(self.display_name).toBe(shortenNodeId(self.orca_node_id));
      expect(admin.config().display_name).toBe(shortenNodeId(self.orca_node_id));
      const { suggested_endpoints: suggested, bind_choices: choices, advanced } = admin.config();
      for (const url of suggested) expect(url.startsWith("http://")).toBe(true);
      expect(choices.slice(0, 2)).toEqual(["127.0.0.1", "::"]);
      expect(advanced).toMatchObject({
        max_workspace_bytes: 5 * 1024 ** 3,
        max_workspace_files: 50_000,
      });
    } finally {
      await handle.stop();
    }
  });

  it("stays idle until the first-run wizard supplies a workgroup", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle, stores } = launch({ port: 0, data_root: root });
    await handle.ready;
    try {
      const admin = adminFor(handle);
      expect(handle.node).toBeNull();
      expect(handle.error).toBeNull();
      expect(admin.config().configured).toBe(false);
      expect(admin.config().running).toBe(false);

      await admin.saveConfig({ workgroup_id: wg("wg-fresh"), workgroup_password: "pw-fresh" });

      expect(handle.node).not.toBeNull();
      expect(handle.error).toBeNull();
      expect(handle.configured).toBe(true);
      expect(stores.secrets.get("ORCA_POD_PASSWORD_WG_FRESH")).toBe("pw-fresh");
      expect(admin.config()).toMatchObject({ configured: true, running: true, workgroup_id: "wg-fresh" });
    } finally {
      await handle.stop();
    }
  });

  it("keeps the node idle while the workgroup password is missing", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle } = launch(bundle(root));
    await handle.ready;
    try {
      const view = adminFor(handle).config();
      expect(view.running).toBe(false);
      expect(view.configured).toBe(false);
      expect(view.password_set).toBe(false);
      expect(view.error).toBeNull();
      expect(handle.node).toBeNull();
      // Saving other settings cannot complete the setup without a password.
      await expect(handle.reconfigure({ display_name: "no secret yet" })).rejects.toThrow(/password is required/);
    } finally {
      await handle.stop();
    }
  });

  it("rejects saving a blank workgroup password", async () => {
    const root = await tempRoot("orca-panel-");
    const { handle } = launch(bundle(root));
    await handle.ready;
    try {
      await expect(adminFor(handle).saveConfig({ workgroup_password: "" })).rejects.toThrow(/password is required/);
      await expect(adminFor(handle).saveConfig({ workgroup_password: "   " })).rejects.toThrow(/password is required/);
    } finally {
      await handle.stop();
    }
  });

  it("disconnects: leaves known peers and forgets remembered and configured ones", async () => {
    const rootA = await tempRoot("orca-panel-a-");
    const rootB = await tempRoot("orca-panel-b-");
    const b = await started(bundle(rootB, "wg-leave"));
    const a = await started({ ...bundle(rootA, "wg-leave"), peers: [b.handle.url!] });
    try {
      await a.handle.addPeer(b.handle.url!);
      expect(a.handle.rememberedPeers).toHaveLength(1);
      const admin = adminFor(a.handle);
      await admin.disconnect();
      expect(a.handle.rememberedPeers).toEqual([]);
      expect(await readJson(peerStatePath(rootA))).toEqual({ peers: [] });
      expect(a.stores.raw()).not.toHaveProperty("peers");
      expect(admin.config().peers).toEqual([]);
      expect(admin.members().map((member) => member.orca_node_id)).toEqual([]);
    } finally {
      await a.handle.stop();
      await b.handle.stop();
    }
  });
});
