/**
 * Panel-driven configuration (§9.2): settings written to the machine's settings
 * file, the workgroup password and the node key kept in the credential store,
 * live reconfiguration, peers remembered as runtime state, and the panel read
 * model that never exposes the password.
 */

import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shortenNodeId } from "../src/core/identity.ts";
import { normalizePeerUrl } from "../src/core/net.ts";
import { PanelModel } from "../src/plugin/panel.ts";
import { Pod } from "../src/plugin/pod.ts";
import { MemoryPodStores } from "../src/plugin/stores.ts";
import { PanelPatchSchema } from "../src/node/settings.ts";
import { ApprovalBroker } from "../src/plugin/broker.ts";
import { PodTool } from "../src/plugin/tools.ts";
import { Tracker } from "../src/plugin/tracker.ts";
import { wg } from "./fixtures/ids.ts";
import { catalogFeed, idlePod, logger } from "./fixtures/pod.ts";
import { peersOf } from "./support/node.ts";

const peerStatePath = (root: string): string => join(root, "peers.json");
const settingsPath = (root: string): string => join(root, "settings.json");
const roots: string[] = [];
const PASSWORD = "panel-password";

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

/** The settings of a node in the default test workgroup: what the settings file holds, no password. */
function bundle(workgroupId = "wg-panel"): Record<string, unknown> {
  return { workgroup_id: workgroupId, display_name: "panel node", port: 0 };
}

type Launched = { handle: Pod; stores: MemoryPodStores; root: string };

/**
 * Start a pod over in-memory credentials. `settings` are written to the settings
 * file first, the way an earlier session would have left them; `password` and
 * `stores` say what the credential store holds.
 */
async function launch(
  settings: Record<string, unknown>,
  options: { password?: string; stores?: MemoryPodStores; root?: string } = {},
): Promise<Launched> {
  const root = options.root ?? (await tempRoot("orca-panel-"));
  const stores = options.stores ?? new MemoryPodStores({ password: options.password });
  if (Object.keys(settings).length > 0) {
    await mkdir(root, { recursive: true });
    await writeFile(settingsPath(root), JSON.stringify(settings));
  }
  const handle = new Pod(logger, stores, catalogFeed(), root);
  handle.start();
  return { handle, stores, root };
}

/** Launch and complete the setup the first-run wizard would perform. */
async function started(settings: Record<string, unknown>, root?: string): Promise<Launched> {
  const pod = await launch(settings, { root });
  await pod.handle.settled();
  if (pod.handle.run === null) await pod.handle.reconfigure({ workgroup_password: PASSWORD });
  return pod;
}

/** The URL a running pod listens on. */
const urlOf = (handle: Pod): string => handle.run!.orca.mesh.self.endpoints[0]!;

function panelFor(handle: Pod): PanelModel {
  return new PanelModel(handle, new ApprovalBroker(handle), catalogFeed());
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("panel configuration of the pod", () => {
  it("waits for the workgroup password, then keeps it in the credential store only", async () => {
    const { handle, stores, root } = await launch(bundle());
    await handle.settled();
    try {
      // A settings file that names a workgroup is not enough: without a stored
      // password a fresh install must not listen (§7.1).
      expect(handle.configured).toBe(false);
      expect(handle.status.kind).not.toBe("failed");
      expect(handle.run).toBeNull();

      await handle.reconfigure({ display_name: "renamed node", workgroup_password: PASSWORD });

      expect(handle.configured).toBe(true);
      expect(handle.settings.display_name).toBe("renamed node");
      expect(handle.status.kind).not.toBe("failed");
      expect(stores.password).toBe(PASSWORD);
      expect(await readJson(settingsPath(root))).toMatchObject({ display_name: "renamed node" });
      // Neither the settings file nor the node config carries the password.
      expect(await readFile(settingsPath(root), "utf8")).not.toContain(PASSWORD);
      expect(JSON.stringify(handle.run!.orca.config)).not.toContain(PASSWORD);

      const firstId = handle.run!.orca.orcaNodeId;
      await handle.reconfigure({ display_name: "renamed again" });
      expect(handle.run!.orca.orcaNodeId).toBe(firstId);
    } finally {
      await handle.stop();
    }
  });

  it("starts at once when the credential store already holds the password", async () => {
    const { handle } = await launch(bundle(), { password: PASSWORD });
    await handle.settled();
    try {
      expect(handle.configured).toBe(true);
      expect(handle.run).not.toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it("makes the node key in the credential store on first start and keeps it", async () => {
    const { handle, stores } = await launch(bundle(), { password: PASSWORD });
    await handle.settled();
    try {
      expect((await stores.readIdentity())?.orcaNodeId).toBe(handle.run!.orca.orcaNodeId);
    } finally {
      await handle.stop();
    }
  });

  it("rotates the password in place when no setting changes", async () => {
    const { handle, stores, root } = await started(bundle());
    try {
      const before = await readFile(settingsPath(root), "utf8");
      const firstRun = handle.run;
      await handle.reconfigure({ workgroup_password: "rotated" });
      expect(stores.password).toBe("rotated");
      expect(await readFile(settingsPath(root), "utf8")).toBe(before);
      expect(handle.run).not.toBeNull();
      expect(handle.run).not.toBe(firstRun);
    } finally {
      await handle.stop();
    }
  });

  it("reports where the pod is: starting, unconfigured, running, failed, stopped", async () => {
    const { handle } = await launch(bundle());
    // A restart is queued the moment `start` returns: nobody may be handed a node yet.
    expect(handle.status).toEqual({ kind: "starting" });
    expect(handle.run).toBeNull();
    expect(() => handle.requireRun()).toThrow(/not running: it is still starting/);
    await handle.settled();
    expect(handle.status).toEqual({ kind: "unconfigured" });
    expect(() => handle.requireRun()).toThrow(/not running: the workgroup and its password are not set up/);

    await handle.reconfigure({ workgroup_password: PASSWORD });
    expect(handle.status.kind).toBe("running");
    expect(handle.requireRun()).toBe(handle.run);
    expect(handle.run!.port).toBeGreaterThan(0);

    // Another process of this machine (its own data root here) cannot listen on the
    // port: its start fails, and the status says a node is already running.
    const taken = await launch({ ...bundle(), port: handle.run!.port }, { password: PASSWORD });
    await taken.handle.settled();
    expect(taken.handle.status).toMatchObject({ kind: "failed", error: expect.any(Error) });
    expect(() => taken.handle.requireRun()).toThrow(
      /not running: an orca node is already running on this machine, in another DSH process/,
    );
    await taken.handle.stop();

    await handle.stop();
    expect(handle.status).toEqual({ kind: "stopped" });
    expect(() => handle.requireRun()).toThrow(/not running: the pod was stopped/);
    // A restart asked for after the stop starts nothing.
    await handle.reconfigure({ display_name: "too late" });
    expect(handle.status).toEqual({ kind: "stopped" });
  });

  it("fails with the file's name when the settings file cannot be read, and leaves it alone", async () => {
    const root = await tempRoot("orca-panel-");
    await writeFile(settingsPath(root), "{ not json");
    const { handle } = await launch({}, { root, password: PASSWORD });
    await handle.settled();
    try {
      expect(handle.status).toMatchObject({ kind: "failed" });
      expect(() => handle.requireRun()).toThrow(/settings\.json is not valid JSON/);
      expect(await readFile(settingsPath(root), "utf8")).toBe("{ not json");
    } finally {
      await handle.stop();
    }
  });

  it("makes a tool call wait for an in-place restart instead of reporting that nothing runs", async () => {
    const { handle, stores } = await started(bundle());
    try {
      // Hold the restart at the point where the old node is gone and the new one is not up yet.
      const readPassword = stores.readPassword.bind(stores);
      let reachedBoot!: () => void;
      const reached = new Promise<void>((resolve) => (reachedBoot = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(stores, "readPassword").mockImplementationOnce(async () => {
        reachedBoot();
        await gate;
        return readPassword();
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
      expect(JSON.stringify((outcome as { value: unknown }).value)).toContain(handle.run!.orca.orcaNodeId);
    } finally {
      await handle.stop();
    }
  });

  it("keeps the pod queue usable after a rejected reconfigure", async () => {
    const { handle } = await started(bundle());
    try {
      await expect(handle.reconfigure({ port: -1 })).rejects.toThrow();
      // The failed operation must not poison the serial lane.
      await handle.reconfigure({ display_name: "recovered" });
      expect(handle.run).not.toBeNull();
      expect(handle.settings.display_name).toBe("recovered");
    } finally {
      await handle.stop();
    }
  });

  it("applies a parsed panel patch and lets null clear a configured value", async () => {
    const { handle, root } = await started({ ...bundle(), task_timeout_s: 90 });
    try {
      // The panel route parses the body first: keys the panel may not edit never reach the pod.
      await handle.reconfigure(PanelPatchSchema.parse({ data_root: "/elsewhere", display_name: "kept" }));
      expect(handle.dataRoot).toBe(root);
      expect(await readJson(settingsPath(root))).not.toHaveProperty("data_root");
      expect(handle.settings.task_timeout_s).toBe(90);
      expect(handle.settings.display_name).toBe("kept");

      await handle.reconfigure({ task_timeout_s: null });
      expect(handle.settings.task_timeout_s).toBeUndefined();
      expect(await readJson(settingsPath(root))).not.toHaveProperty("task_timeout_s");
      expect(handle.run!.orca.config.task_timeout_s).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it("stops instead of starting a node when it is disposed mid-reconfigure", async () => {
    const { handle } = await started(bundle());
    try {
      const reconfiguring = handle.reconfigure({ display_name: "late rename" });
      const stopping = handle.stop();
      await Promise.allSettled([reconfiguring, stopping]);
      // stopPod waits for the queued restart, and that operation must not start
      // a fresh listener after the host disposed the pod.
      expect(handle.run).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it("listens on loopback until the panel picks an interface", async () => {
    const { handle, root } = await started(bundle());
    try {
      expect(handle.run!.orca.config.bind_host).toBe("127.0.0.1");

      const view = await panelFor(handle).saveConfig({ bind_host: "0.0.0.0" });
      expect(view.bind_host).toBe("0.0.0.0");
      expect((await readJson(settingsPath(root))).bind_host).toBe("0.0.0.0");
      expect(handle.run!.orca.config.bind_host).toBe("0.0.0.0");
    } finally {
      await handle.stop();
    }
  });

  it("applies advanced connection and timeout controls from the panel", async () => {
    const { handle, root } = await started(bundle());
    try {
      const panel = panelFor(handle);
      const view = await panel.saveConfig({
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
      expect(handle.status.kind).not.toBe("failed");

      expect((await readJson(settingsPath(root))).task_timeout_s).toBe(120);
      const nodeConfig = handle.run!.orca.config;
      expect(nodeConfig.task_timeout_s).toBe(120);
      expect(nodeConfig.result_max_bytes).toBe(4096);
      expect(nodeConfig.permission_mode).toBe("workspace-write");
      expect(nodeConfig.default_reasoning_effort).toBe("max");
      expect(nodeConfig.executor).toBe("echo");

      // Clearing a field removes it from the settings file and the node config,
      // so the local default applies again instead of a stale stored value.
      const cleared = await panel.saveConfig({ task_timeout_s: null, default_reasoning_effort: null, executor: null });
      expect(cleared.advanced.task_timeout_s).toBeNull();
      expect(cleared.advanced.default_reasoning_effort).toBeNull();
      expect(cleared.advanced.executor).toBeNull();
      const clearedConfig = handle.run!.orca.config;
      expect(clearedConfig.task_timeout_s).toBeUndefined();
      expect(clearedConfig.default_reasoning_effort).toBeUndefined();
      // Clearing the executor falls back to the plugin default (acp).
      expect(clearedConfig.executor).toBe("acp");
    } finally {
      await handle.stop();
    }
  });

  it("full reset deletes everything the machine's node has, and returns to the wizard", async () => {
    const { handle, stores, root } = await started(bundle());
    const other = await started(bundle());
    try {
      await handle.addPeer(urlOf(other.handle));
      const before = handle.run!.orca.orcaNodeId;
      expect(handle.configured).toBe(true);
      expect(await stores.readIdentity()).toBeDefined();

      await handle.reset();

      expect(handle.configured).toBe(false);
      expect(handle.status.kind).not.toBe("failed");
      // Reset returns to the wizard: nothing restarts until setup completes.
      expect(handle.run).toBeNull();
      expect(stores.password).toBeUndefined();
      expect(await stores.readIdentity()).toBeUndefined();
      await expect(readFile(settingsPath(root), "utf8")).rejects.toThrow();
      await expect(readFile(peerStatePath(root), "utf8")).rejects.toThrow();
      expect(handle.settings.workgroup_id).toBeUndefined();

      const view = await panelFor(handle).saveConfig({ workgroup_id: wg("wg-panel"), workgroup_password: PASSWORD });
      expect(view.running).toBe(true);
      expect(handle.run!.orca.orcaNodeId).not.toBe(before);
    } finally {
      await handle.stop();
      await other.handle.stop();
    }
  });

  it("keeps the configuration and the orca node id on the next start", async () => {
    const first = await started(bundle());
    const firstId = first.handle.run!.orca.orcaNodeId;
    await first.handle.stop();

    const second = await launch({}, { root: first.root, stores: first.stores });
    await second.handle.settled();
    try {
      expect(second.handle.configured).toBe(true);
      expect(second.handle.status.kind).not.toBe("failed");
      expect(second.handle.run!.orca.orcaNodeId).toBe(firstId);
    } finally {
      await second.handle.stop();
    }
  });

  it("remembers a peer joined live as runtime state, not as a setting", async () => {
    const a = await started(bundle());
    const b = await started(bundle());
    try {
      const peerUrl = urlOf(b.handle);
      await a.handle.addPeer(peerUrl);
      expect(a.handle.rememberedPeers).toEqual([peerUrl]);
      expect(await readJson(peerStatePath(a.root))).toEqual({ peers: [peerUrl] });
      expect(await readJson(settingsPath(a.root))).not.toHaveProperty("peers");
      expect((await panelFor(a.handle).config()).peers).toEqual([peerUrl]);
    } finally {
      await a.handle.stop();
      await b.handle.stop();
    }
  });

  it("rejoins the remembered peers when the node starts", async () => {
    const b = await started(bundle());
    try {
      const peerUrl = urlOf(b.handle);
      // What an earlier session left behind; startup tries it once without
      // waiting for the operator to click Connect again.
      const rootA = await tempRoot("orca-panel-a-");
      await writeFile(peerStatePath(rootA), JSON.stringify({ peers: [peerUrl] }), "utf8");
      const a = await started(bundle(), rootA);
      try {
        const want = b.handle.run!.orca.orcaNodeId;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (peersOf(a.handle.run!.orca).some((member) => member.state === "online")) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        expect(peersOf(a.handle.run!.orca).map((member) => member.orca_node_id)).toContain(want);
      } finally {
        await a.handle.stop();
      }
    } finally {
      await b.handle.stop();
    }
  });

  it("does not remember a peer that cannot be joined", async () => {
    const { handle, root } = await started(bundle());
    try {
      await expect(handle.addPeer("http://127.0.0.1:1")).rejects.toThrow();
      expect(handle.rememberedPeers).toEqual([]);
      await expect(readFile(peerStatePath(root), "utf8")).rejects.toThrow();
    } finally {
      await handle.stop();
    }
  });
});

describe("credentials changed outside the pod", () => {
  it("restarts once on a new password, keeping the node", async () => {
    const { handle, stores } = await started(bundle());
    try {
      const run = handle.run;
      const id = run!.orca.orcaNodeId;

      stores.password = "changed elsewhere";
      handle.credentialsChanged();
      await handle.settled();

      expect(handle.run).not.toBe(run);
      expect(handle.run!.orca.orcaNodeId).toBe(id);
    } finally {
      await handle.stop();
    }
  });

  it("does nothing when the change is one this run already uses, such as the pod's own write", async () => {
    const { handle } = await started(bundle());
    try {
      await handle.reconfigure({ workgroup_password: "rotated" });
      const run = handle.run;

      // The host reports the write the pod just made.
      handle.credentialsChanged();
      await handle.settled();

      expect(handle.run).toBe(run);
    } finally {
      await handle.stop();
    }
  });

  it("takes a new node key as a new node", async () => {
    const { handle, stores } = await started(bundle());
    try {
      const id = handle.run!.orca.orcaNodeId;

      await stores.deleteIdentity();
      handle.credentialsChanged();
      await handle.settled();

      expect(handle.run!.orca.orcaNodeId).not.toBe(id);
      expect((await stores.readIdentity())?.orcaNodeId).toBe(handle.run!.orca.orcaNodeId);
    } finally {
      await handle.stop();
    }
  });

  it("starts a pod that was waiting for its password when one appears", async () => {
    const { handle, stores } = await launch(bundle());
    await handle.settled();
    try {
      expect(handle.run).toBeNull();

      stores.password = PASSWORD;
      handle.credentialsChanged();
      await handle.settled();

      expect(handle.run).not.toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it("changes nothing in a pod that was stopped", async () => {
    const { handle, stores } = await started(bundle());
    await handle.stop();
    stores.password = "after the stop";
    handle.credentialsChanged();
    await handle.settled();
    expect(handle.status).toEqual({ kind: "stopped" });
  });
});

describe("panel model configuration", () => {
  it("never exposes the workgroup password", async () => {
    const { handle } = await started(bundle());
    try {
      const view = await panelFor(handle).config();
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

  it("asks the credential store whether a password is set, not what the last start read", async () => {
    const { handle, stores } = await started(bundle());
    try {
      expect((await panelFor(handle).config()).password_set).toBe(true);
      stores.password = undefined;
      expect((await panelFor(handle).config()).password_set).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it("switches the workgroup and keeps the machine's password", async () => {
    const { handle, stores } = await started(bundle());
    try {
      const firstId = handle.run!.orca.orcaNodeId;

      const view = await panelFor(handle).saveConfig({ workgroup_id: wg("wg-other") });

      expect(view.workgroup_id).toBe("wg-other");
      expect(view.password_set).toBe(true);
      expect(stores.password).toBe(PASSWORD);
      expect(handle.run!.orca.orcaNodeId).toBe(firstId);
      expect(handle.run!.orca.config.workgroup_id).toBe("wg-other");
    } finally {
      await handle.stop();
    }
  });

  it("normalizes peers before joining them", async () => {
    const seen: string[] = [];
    const handle = idlePod({ workgroup_id: "wg-panel", workgroup_password: "pw" });
    vi.spyOn(handle, "addPeer").mockImplementation(async (peer) => {
      seen.push(peer);
    });
    const panel = panelFor(handle);
    await panel.connect("192.168.1.20:11811");
    await panel.connect("http://desk.example.com/");
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
    const { handle } = await started({ workgroup_id: "wg-id", port: 0 });
    try {
      const panel = panelFor(handle);
      const self = panel.self()!;
      expect(self.display_name).toBe(shortenNodeId(self.orca_node_id));
      const { display_name, suggested_endpoints: suggested, bind_choices: choices, advanced } = await panel.config();
      expect(display_name).toBe(shortenNodeId(self.orca_node_id));
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

  it("shows the data directory the pod was given", async () => {
    const { handle, root } = await started(bundle());
    try {
      expect((await panelFor(handle).config()).data_root).toBe(root);
    } finally {
      await handle.stop();
    }
  });

  it("stays idle until the first-run wizard supplies a workgroup", async () => {
    const { handle, stores } = await launch({ port: 0 });
    await handle.settled();
    try {
      const panel = panelFor(handle);
      expect(handle.run).toBeNull();
      expect(handle.status.kind).not.toBe("failed");
      expect((await panel.config()).configured).toBe(false);
      expect((await panel.config()).running).toBe(false);

      await panel.saveConfig({ workgroup_id: wg("wg-fresh"), workgroup_password: "pw-fresh" });

      expect(handle.run).not.toBeNull();
      expect(handle.status.kind).not.toBe("failed");
      expect(handle.configured).toBe(true);
      expect(stores.password).toBe("pw-fresh");
      expect(await panel.config()).toMatchObject({ configured: true, running: true, workgroup_id: "wg-fresh" });
    } finally {
      await handle.stop();
    }
  });

  it("keeps the node idle while the workgroup password is missing", async () => {
    const { handle } = await launch(bundle());
    await handle.settled();
    try {
      const view = await panelFor(handle).config();
      expect(view.running).toBe(false);
      expect(view.configured).toBe(false);
      expect(view.password_set).toBe(false);
      expect(view.error).toBeNull();
      expect(handle.run).toBeNull();
      // Saving other settings cannot complete the setup without a password.
      await expect(handle.reconfigure({ display_name: "no secret yet" })).rejects.toThrow(/password is required/);
    } finally {
      await handle.stop();
    }
  });

  it("rejects saving a blank workgroup password, and saving without a workgroup", async () => {
    const { handle } = await launch({});
    await handle.settled();
    try {
      await expect(panelFor(handle).saveConfig({ workgroup_password: "" })).rejects.toThrow(/password is required/);
      await expect(panelFor(handle).saveConfig({ workgroup_password: "   " })).rejects.toThrow(/password is required/);
      await expect(panelFor(handle).saveConfig({ workgroup_password: "pw" })).rejects.toThrow(
        /workgroup id is required/,
      );
    } finally {
      await handle.stop();
    }
  });

  it("disconnects: leaves known peers and forgets remembered and configured ones", async () => {
    const b = await started(bundle("wg-leave"));
    const a = await started({ ...bundle("wg-leave"), peers: [urlOf(b.handle)] });
    try {
      await a.handle.addPeer(urlOf(b.handle));
      expect(a.handle.rememberedPeers).toHaveLength(1);
      const panel = panelFor(a.handle);
      await panel.disconnect();
      expect(a.handle.rememberedPeers).toEqual([]);
      expect(await readJson(peerStatePath(a.root))).toEqual({ peers: [] });
      expect(await readJson(settingsPath(a.root))).not.toHaveProperty("peers");
      expect((await panel.config()).peers).toEqual([]);
      expect(panel.members().map((member) => member.orca_node_id)).toEqual([]);
    } finally {
      await a.handle.stop();
      await b.handle.stop();
    }
  });
});
