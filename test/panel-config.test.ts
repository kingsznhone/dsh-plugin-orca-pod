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
import { NODE_KEY, PASSWORD_REF, PodStores } from "../src/plugin/stores.ts";
import { credentialHost, MemoryCredentials, podStores } from "./fixtures/credentials.ts";
import { PanelPatchSchema } from "../src/node/settings.ts";
import { Tracker } from "../src/plugin/tracker.ts";
import type { OptionalService } from "../src/plugin/services.ts";
import { PodTool } from "../src/plugin/tools.ts";
import { wg } from "./fixtures/ids.ts";
import { catalogFeed, idlePod, logger } from "./fixtures/pod.ts";
import { peersOf } from "./support/node.ts";

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

type Launched = { handle: Pod; stores: PodStores; credentials: MemoryCredentials; root: string };

/**
 * Start a pod over in-memory credentials. `settings` are written to the settings
 * file first, the way an earlier session would have left them; `password` and
 * `credentials` say what the credential store holds.
 */
async function launch(
  settings: Record<string, unknown>,
  options: { password?: string; credentials?: MemoryCredentials; root?: string } = {},
): Promise<Launched> {
  const root = options.root ?? (await tempRoot("orca-panel-"));
  const credentials = options.credentials ?? new MemoryCredentials();
  if (options.password !== undefined) credentials.secrets.set(PASSWORD_REF, options.password);
  const stores = podStores(credentials);
  if (Object.keys(settings).length > 0) {
    await mkdir(root, { recursive: true });
    await writeFile(settingsPath(root), JSON.stringify(settings));
  }
  const handle = new Pod(logger, credentialHost(credentials), catalogFeed(), root);
  handle.start();
  return { handle, stores, credentials, root };
}

/** Launch and complete the setup the first-run wizard would perform. */
async function started(settings: Record<string, unknown>, root?: string): Promise<Launched> {
  const pod = await launch(settings, { root });
  await pod.handle.orca().catch(() => undefined);
  if (pod.handle.run === null) await pod.handle.reconfigure({ workgroup_password: PASSWORD });
  return pod;
}

/** The URL a running pod listens on. */
const urlOf = (handle: Pod): string => handle.run!.mesh.self.endpoints[0]!;

function panelFor(handle: Pod): PanelModel {
  return new PanelModel(handle, new Tracker(handle, logger, () => undefined), catalogFeed());
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("panel configuration of the pod", () => {
  it("waits for the workgroup password, then keeps it in the credential store only", async () => {
    const { handle, credentials, root } = await launch(bundle());
    await handle.orca().catch(() => undefined);
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
      expect(credentials.secrets.get(PASSWORD_REF)).toBe(PASSWORD);
      expect(await readJson(settingsPath(root))).toMatchObject({ display_name: "renamed node" });
      // Neither the settings file nor the settings the node runs with carry the password.
      expect(await readFile(settingsPath(root), "utf8")).not.toContain(PASSWORD);
      expect(JSON.stringify(handle.settings)).not.toContain(PASSWORD);

      const firstId = handle.run!.mesh.self.id;
      await handle.reconfigure({ display_name: "renamed again" });
      expect(handle.run!.mesh.self.id).toBe(firstId);
    } finally {
      await handle.stop();
    }
  });

  it("starts at once when the credential store already holds the password", async () => {
    const { handle } = await launch(bundle(), { password: PASSWORD });
    await handle.orca().catch(() => undefined);
    try {
      expect(handle.configured).toBe(true);
      expect(handle.run).not.toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it("makes the node key in the credential store on first start and keeps it", async () => {
    const { handle, stores } = await launch(bundle(), { password: PASSWORD });
    await handle.orca().catch(() => undefined);
    try {
      expect((await stores.readIdentity())?.orcaNodeId).toBe(handle.run!.mesh.self.id);
    } finally {
      await handle.stop();
    }
  });

  it("rotates the password in place when no setting changes", async () => {
    const { handle, credentials, root } = await started(bundle());
    try {
      const before = await readFile(settingsPath(root), "utf8");
      const firstRun = handle.run;
      await handle.reconfigure({ workgroup_password: "rotated" });
      expect(credentials.secrets.get(PASSWORD_REF)).toBe("rotated");
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
    await handle.orca().catch(() => undefined);
    expect(handle.status).toEqual({ kind: "unconfigured" });
    await expect(handle.orca()).rejects.toThrow(/not running: the workgroup and its password are not set up/);

    await handle.reconfigure({ workgroup_password: PASSWORD });
    expect(handle.status.kind).toBe("running");
    expect(await handle.orca()).toBe(handle.run!);
    expect(handle.run!.port).toBeGreaterThan(0);

    // Another process of this machine (its own data root here) cannot listen on the
    // port: its start fails, and the status says a node is already running.
    const taken = await launch({ ...bundle(), port: handle.run!.port }, { password: PASSWORD });
    await taken.handle.orca().catch(() => undefined);
    expect(taken.handle.status).toMatchObject({ kind: "failed", error: expect.any(Error) });
    await expect(taken.handle.orca()).rejects.toThrow(
      /not running: an orca node is already running on this machine, in another DSH process/,
    );
    await taken.handle.stop();

    await handle.stop();
    expect(handle.status).toEqual({ kind: "stopped" });
    await expect(handle.orca()).rejects.toThrow(/not running: the pod was stopped/);
    // A restart asked for after the stop starts nothing.
    await handle.reconfigure({ display_name: "too late" });
    expect(handle.status).toEqual({ kind: "stopped" });
  });

  it("fails with the file's name when the settings file cannot be read, and leaves it alone", async () => {
    const root = await tempRoot("orca-panel-");
    await writeFile(settingsPath(root), "{ not json");
    const { handle } = await launch({}, { root, password: PASSWORD });
    await handle.orca().catch(() => undefined);
    try {
      expect(handle.status).toMatchObject({ kind: "failed" });
      await expect(handle.orca()).rejects.toThrow(/settings\.json is not valid JSON/);
      expect(await readFile(settingsPath(root), "utf8")).toBe("{ not json");
    } finally {
      await handle.stop();
    }
  });

  it("makes a tool call wait for an in-place restart instead of reporting that nothing runs", async () => {
    const { handle } = await started(bundle());
    try {
      // Hold the restart at the point where the old node is gone and the new one is not up yet.
      const { readPassword } = PodStores.prototype;
      let reachedBoot!: () => void;
      const reached = new Promise<void>((resolve) => (reachedBoot = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(PodStores.prototype, "readPassword").mockImplementationOnce(async function (this: PodStores) {
        reachedBoot();
        await gate;
        return readPassword.call(this);
      });
      const rotating = handle.reconfigure({ workgroup_password: "rotated" });
      await reached;

      const tool = new PodTool({ kind: "host", pod: handle }, {
        current: () => undefined,
      } as unknown as OptionalService<"sandboxPolicy">).definition();
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
      expect(JSON.stringify((outcome as { value: unknown }).value)).toContain(handle.run!.mesh.self.id);
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
      expect(handle.settings.task_timeout_s).toBe(3600);
      expect(await readJson(settingsPath(root))).not.toHaveProperty("task_timeout_s");
      // The node advertises the budget it now runs with.
      expect(handle.run!.mesh.self.view().max_task_ttl_s).toBe(3600);
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
      expect(handle.settings.bind_host).toBe("127.0.0.1");

      await handle.reconfigure({ bind_host: "0.0.0.0" });
      const view = await panelFor(handle).config();
      expect(view.settings.bind_host).toBe("0.0.0.0");
      expect((await readJson(settingsPath(root))).bind_host).toBe("0.0.0.0");
      expect(handle.settings.bind_host).toBe("0.0.0.0");
    } finally {
      await handle.stop();
    }
  });

  it("applies advanced connection and timeout controls from the panel", async () => {
    const { handle, root } = await started(bundle());
    try {
      const panel = panelFor(handle);
      await handle.reconfigure({
        task_timeout_s: 120,
        permission_mode: "workspace-write",
        default_reasoning_effort: ReasoningEffortId("max"),
      });
      const view = await panel.config();

      expect(view.settings).toMatchObject({
        task_timeout_s: 120,
        max_workspace_bytes: 5 * 1024 ** 3,
        permission_mode: "workspace-write",
        default_reasoning_effort: ReasoningEffortId("max"),
      });
      expect(handle.status.kind).not.toBe("failed");

      expect((await readJson(settingsPath(root))).task_timeout_s).toBe(120);
      const nodeSettings = handle.settings;
      expect(handle.run!.mesh.self.view().max_task_ttl_s).toBe(120);
      expect(nodeSettings.permission_mode).toBe("workspace-write");
      expect(nodeSettings.default_reasoning_effort).toBe("max");

      // Clearing a field removes it from the settings file and the node's settings,
      // so the local default applies again instead of a stale stored value.
      await handle.reconfigure({ task_timeout_s: null, default_reasoning_effort: null });
      const cleared = await panel.config();
      expect(cleared.settings.task_timeout_s).toBe(3600);
      expect(cleared.settings.default_reasoning_effort).toBeUndefined();
      expect(handle.run!.mesh.self.view().max_task_ttl_s).toBe(3600);
      expect(handle.settings.default_reasoning_effort).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it("full reset deletes everything the machine's node has, and returns to the wizard", async () => {
    const { handle, stores, credentials, root } = await started(bundle());
    const other = await started(bundle());
    try {
      await handle.addPeer(urlOf(other.handle));
      const before = handle.run!.mesh.self.id;
      expect(handle.configured).toBe(true);
      expect(await stores.readIdentity()).toBeDefined();

      await handle.reset();

      expect(handle.configured).toBe(false);
      expect(handle.status.kind).not.toBe("failed");
      // Reset returns to the wizard: nothing restarts until setup completes.
      expect(handle.run).toBeNull();
      expect(credentials.secrets.get(PASSWORD_REF)).toBeUndefined();
      expect(await stores.readIdentity()).toBeUndefined();
      await expect(readFile(settingsPath(root), "utf8")).rejects.toThrow();
      expect(handle.settings.workgroup_id).toBeUndefined();
      expect(handle.settings.peers).toEqual([]);

      await handle.reconfigure({ workgroup_id: wg("wg-panel"), workgroup_password: PASSWORD });
      expect(handle.run).not.toBeNull();
      expect(handle.run!.mesh.self.id).not.toBe(before);
    } finally {
      await handle.stop();
      await other.handle.stop();
    }
  });

  it("keeps the configuration and the orca node id on the next start", async () => {
    const first = await started(bundle());
    const firstId = first.handle.run!.mesh.self.id;
    await first.handle.stop();

    const second = await launch({}, { root: first.root, credentials: first.credentials });
    await second.handle.orca().catch(() => undefined);
    try {
      expect(second.handle.configured).toBe(true);
      expect(second.handle.status.kind).not.toBe("failed");
      expect(second.handle.run!.mesh.self.id).toBe(firstId);
    } finally {
      await second.handle.stop();
    }
  });

  it("adds a peer joined live to the settings' peers, without restarting the node", async () => {
    const a = await started(bundle());
    const b = await started(bundle());
    try {
      const run = a.handle.run;
      const peerUrl = urlOf(b.handle);
      await a.handle.addPeer(peerUrl);
      await a.handle.addPeer(peerUrl);
      expect((await readJson(settingsPath(a.root))).peers).toEqual([peerUrl]);
      expect(a.handle.run).toBe(run);
    } finally {
      await a.handle.stop();
      await b.handle.stop();
    }
  });

  it("joins the settings' peers when the node starts", async () => {
    const b = await started(bundle());
    try {
      const peerUrl = urlOf(b.handle);
      // What an earlier session joined; startup tries it without waiting for the
      // operator to click Connect again.
      const a = await started({ ...bundle(), peers: [peerUrl] });
      try {
        const want = b.handle.run!.mesh.self.id;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (peersOf(a.handle.run!).some((member) => member.state === "online")) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        expect(peersOf(a.handle.run!).map((member) => member.orca_node_id)).toContain(want);
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
      expect(handle.settings.peers).toEqual([]);
      expect(await readJson(settingsPath(root))).not.toHaveProperty("peers");
    } finally {
      await handle.stop();
    }
  });
});

describe("credentials changed outside the pod", () => {
  it("restarts once on a new password, keeping the node", async () => {
    const { handle, credentials } = await started(bundle());
    try {
      const run = handle.run;
      const id = run!.mesh.self.id;

      credentials.secrets.set(PASSWORD_REF, "changed elsewhere");
      handle.credentialsChanged(PASSWORD_REF);
      await handle.orca().catch(() => undefined);

      expect(handle.run).not.toBe(run);
      expect(handle.run!.mesh.self.id).toBe(id);
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
      handle.credentialsChanged(PASSWORD_REF);
      await handle.orca().catch(() => undefined);

      expect(handle.run).toBe(run);
    } finally {
      await handle.stop();
    }
  });

  it("takes a new node key as a new node", async () => {
    const { handle, stores } = await started(bundle());
    try {
      const id = handle.run!.mesh.self.id;

      await stores.deleteIdentity();
      handle.credentialsChanged(NODE_KEY);
      await handle.orca().catch(() => undefined);

      expect(handle.run!.mesh.self.id).not.toBe(id);
      expect((await stores.readIdentity())?.orcaNodeId).toBe(handle.run!.mesh.self.id);
    } finally {
      await handle.stop();
    }
  });

  it("starts a pod that was waiting for its password when one appears", async () => {
    const { handle, credentials } = await launch(bundle());
    await handle.orca().catch(() => undefined);
    try {
      expect(handle.run).toBeNull();

      credentials.secrets.set(PASSWORD_REF, PASSWORD);
      handle.credentialsChanged(PASSWORD_REF);
      await handle.orca().catch(() => undefined);

      expect(handle.run).not.toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it("changes nothing in a pod that was stopped", async () => {
    const { handle, credentials } = await started(bundle());
    await handle.stop();
    credentials.secrets.set(PASSWORD_REF, "after the stop");
    handle.credentialsChanged(PASSWORD_REF);
    await handle.orca().catch(() => undefined);
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
        settings: { workgroup_id: "wg-panel" },
        error: null,
      });
      expect(JSON.stringify(view)).not.toContain(PASSWORD);
    } finally {
      await handle.stop();
    }
  });

  it("switches the workgroup and keeps the machine's password", async () => {
    const { handle, credentials } = await started(bundle());
    try {
      const firstId = handle.run!.mesh.self.id;

      await handle.reconfigure({ workgroup_id: wg("wg-other") });
      const view = await panelFor(handle).config();

      expect(view.settings.workgroup_id).toBe("wg-other");
      expect(credentials.secrets.get(PASSWORD_REF)).toBe(PASSWORD);
      expect(handle.run!.mesh.self.id).toBe(firstId);
      expect(handle.settings.workgroup_id).toBe("wg-other");
    } finally {
      await handle.stop();
    }
  });

  it("normalizes peers before joining them", async () => {
    // An address that is not one is refused before anything is joined or remembered.
    const handle = idlePod({ workgroup_id: "wg-panel", workgroup_password: "pw" });
    await expect(handle.addPeer("http://desk.example.com/a2a")).rejects.toThrow(/without a path/);
    // Nodes speak https only: every address comes out https.
    expect(normalizePeerUrl("10.0.0.2")).toBe("https://10.0.0.2:11811");
    expect(normalizePeerUrl("10.0.0.2:11811")).toBe("https://10.0.0.2:11811");
    expect(normalizePeerUrl("https://10.0.0.2:11811/")).toBe("https://10.0.0.2:11811");
    // https without a port is a node behind a proxy, on 443.
    expect(normalizePeerUrl("https://desk.example.com")).toBe("https://desk.example.com:443");
    // http, which older settings and peers wrote, is the same node at https, on the node port when none is named.
    expect(normalizePeerUrl("http://10.0.0.2:11811/")).toBe("https://10.0.0.2:11811");
    expect(normalizePeerUrl("http://desk.example.com")).toBe("https://desk.example.com:11811");
    expect(normalizePeerUrl("[fd00::12]")).toBe("https://[fd00::12]:11811");
    expect(normalizePeerUrl("[fd00::12]:11811")).toBe("https://[fd00::12]:11811");
    expect(normalizePeerUrl("fd00::12")).toBe("https://[fd00::12]:11811");
    expect(normalizePeerUrl("https://[fd00::12]:11811")).toBe("https://[fd00::12]:11811");
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
      const self = (await panel.state()).self!;
      expect(self.display_name).toBe(shortenNodeId(self.orca_node_id));
      const { suggested_endpoints: suggested, bind_choices: choices, settings } = await panel.config();
      for (const url of suggested) expect(url.startsWith("https://")).toBe(true);
      expect(choices.slice(0, 2)).toEqual(["127.0.0.1", "::"]);
      expect(settings).toMatchObject({ max_workspace_bytes: 5 * 1024 ** 3 });
    } finally {
      await handle.stop();
    }
  });

  it("shows the settings but not the ACP executor's, which only the settings file sets", async () => {
    const acp = { command: "do-not-show" };
    const { handle } = await started({ ...bundle(), acp });
    try {
      const view = await panelFor(handle).config();
      expect(view.settings.display_name).toBe("panel node");
      expect(view.settings).not.toHaveProperty("acp");
      expect(JSON.stringify(view)).not.toContain("do-not-show");
    } finally {
      await handle.stop();
    }
  });

  it("stays idle until the first-run wizard supplies a workgroup", async () => {
    const { handle, credentials } = await launch({ port: 0 });
    await handle.orca().catch(() => undefined);
    try {
      const panel = panelFor(handle);
      expect(handle.run).toBeNull();
      expect(handle.status.kind).not.toBe("failed");
      expect((await panel.config()).configured).toBe(false);
      expect((await panel.state()).self).toBeNull();

      await handle.reconfigure({ workgroup_id: wg("wg-fresh"), workgroup_password: "pw-fresh" });

      expect(handle.run).not.toBeNull();
      expect(handle.status.kind).not.toBe("failed");
      expect(handle.configured).toBe(true);
      expect(credentials.secrets.get(PASSWORD_REF)).toBe("pw-fresh");
      expect(await panel.config()).toMatchObject({
        configured: true,
        settings: { workgroup_id: "wg-fresh" },
      });
    } finally {
      await handle.stop();
    }
  });

  it("keeps the node idle while the workgroup password is missing", async () => {
    const { handle } = await launch(bundle());
    await handle.orca().catch(() => undefined);
    try {
      const view = await panelFor(handle).config();
      expect(handle.run).toBeNull();
      expect(view.configured).toBe(false);
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
    await handle.orca().catch(() => undefined);
    try {
      // A blank password never reaches the pod: the panel's patch schema refuses it.
      for (const blank of ["", "   "]) {
        expect(PanelPatchSchema.safeParse({ workgroup_password: blank }).error?.issues[0]?.message).toMatch(
          /password is required/,
        );
      }
      await expect(handle.reconfigure({ workgroup_password: "pw" })).rejects.toThrow(/workgroup id is required/);
      // Nothing was stored on the way.
      expect(handle.settings.workgroup_id).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });
});
