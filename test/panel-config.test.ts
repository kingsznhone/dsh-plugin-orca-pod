/**
 * Panel-driven configuration (§9.2): the `ui-config.json` override, live
 * reconfiguration, peer joins from the UI, and the admin read model that never
 * exposes the workgroup password.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { configPath } from "../src/config.ts";
import { shortenNodeId } from "../src/identity.ts";
import { createPodAdmin, normalizePeer } from "../src/plugin/admin.ts";
import type { PodAdmin } from "../src/plugin/admin.ts";
import type { Config } from "../src/plugin/config.ts";
import type { HostLogger } from "../src/plugin/dsh.ts";
import { overridePath, startPod, stopPod } from "../src/plugin/lifecycle.ts";
import type { PodHandle } from "../src/plugin/lifecycle.ts";
import { createTracker } from "../src/plugin/tracker.ts";

const logger: HostLogger = { info: () => {}, warn: () => {}, error: () => {} };
const roots: string[] = [];

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

function baseConfig(root: string, workgroupId = "wg-panel"): Config {
  return {
    workgroup_id: workgroupId,
    workgroup_password: "panel-password",
    display_name: "panel node",
    port: 0,
    skill_injection: false,
    peers: [],
    data_root: root,
  };
}

function adminFor(handle: PodHandle): PodAdmin {
  return createPodAdmin(handle, createTracker(() => null, { intervalMs: 60_000 }));
}

/**
 * Start a pod and, when it is still waiting for the panel wizard, complete the
 * setup the wizard would perform. Tests that assert the idle state use
 * `startPod` directly.
 */
async function startedPod(config: Config, patch: Record<string, unknown> = {}): Promise<PodHandle> {
  const handle = startPod(config, logger);
  await handle.ready;
  if (handle.runtime.orcaNode === null) await handle.reconfigure(patch);
  return handle;
}

describe("panel override lifecycle", () => {
  it("waits for the panel setup before starting a node", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      expect(handle.uiConfigured).toBe(false);
      expect(handle.runtime.error).toBeNull();
      // A bundle config that still carries a workgroup is not enough: a fresh
      // install must not listen before the wizard completes (§7.1).
      expect(handle.runtime.orcaNode).toBeNull();

      await handle.reconfigure({ display_name: "renamed node", peers: [] });

      expect(handle.uiConfigured).toBe(true);
      expect(handle.config.display_name).toBe("renamed node");
      expect(handle.runtime.error).toBeNull();
      const firstId = handle.runtime.orcaNode!.self().orca_node_id;
      const stored = JSON.parse(await readFile(overridePath(root), "utf8")) as Record<string, unknown>;
      expect(stored["setup_complete"]).toBe(true);
      expect(stored["display_name"]).toBe("renamed node");

      await handle.reconfigure({ display_name: "renamed again", peers: [] });
      expect(handle.runtime.orcaNode!.self().orca_node_id).toBe(firstId);
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("keeps the lifecycle queue usable after a rejected reconfigure", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      await expect(handle.reconfigure({ port: -1 })).rejects.toThrow();
      // The failed operation must not poison the serial lane (§ plugin H9).
      await handle.reconfigure({ display_name: "recovered" });
      expect(handle.runtime.orcaNode).not.toBeNull();
      expect(handle.config.display_name).toBe("recovered");
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("stops instead of starting a node when it is disposed mid-reconfigure", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startedPod(baseConfig(root));
    const pod = await handle;
    try {
      const reconfiguring = pod.reconfigure({ display_name: "late rename" });
      const stopping = stopPod(pod, logger);
      await Promise.allSettled([reconfiguring, stopping]);
      // stopPod waits for the queued reconfigure, and that operation must not
      // start a fresh listener after the host disposed the pod (§ plugin H9).
      expect(pod.runtime.orcaNode).toBeNull();
    } finally {
      await stopPod(pod, logger);
    }
  });

  it("listens on loopback until the panel picks an interface", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      await handle.reconfigure({ peers: [] });
      const saved = JSON.parse(await readFile(configPath(root), "utf8")) as { bind?: { host?: string } };
      expect(saved.bind?.host).toBe("127.0.0.1");

      const admin = adminFor(handle);
      const view = await admin.saveConfig({ bind_host: "0.0.0.0" });
      expect(view.bind_host).toBe("0.0.0.0");
      const updated = JSON.parse(await readFile(configPath(root), "utf8")) as { bind?: { host?: string } };
      expect(updated.bind?.host).toBe("0.0.0.0");
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("applies advanced connection and timeout controls from the panel", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      const admin = adminFor(handle);
      const view = await admin.saveConfig({
        task_timeout_s: 120,
        approval_timeout_s: 45,
        result_max_bytes: 4096,
        max_input_files: 4,
        max_input_bytes: 1048576,
        allow_public_peers: true,
        allow_loopback_peers: false,
        permission_mode: "workspace-write",
        default_reasoning_effort: "max",
        executor: "echo",
      });

      expect(view.advanced).toEqual({
        task_timeout_s: 120,
        approval_timeout_s: 45,
        result_max_bytes: 4096,
        max_input_files: 4,
        max_input_bytes: 1048576,
        allow_public_peers: true,
        allow_loopback_peers: false,
        permission_mode: "workspace-write",
        default_reasoning_effort: "max",
        executor: "echo",
      });
      expect(handle.runtime.error).toBeNull();

      const stored = JSON.parse(await readFile(overridePath(root), "utf8")) as Record<string, unknown>;
      expect(stored["task_timeout_s"]).toBe(120);
      const nodeConfig = JSON.parse(await readFile(configPath(root), "utf8")) as Record<string, unknown>;
      expect(nodeConfig["task_timeout_s"]).toBe(120);
      expect(nodeConfig["max_input_bytes"]).toBe(1048576);
      expect(nodeConfig["permission_mode"]).toBe("workspace-write");
      expect(nodeConfig["default_reasoning_effort"]).toBe("max");
      expect(nodeConfig["executor"]).toBe("echo");

      // Clearing a field removes it from the override and the persisted config,
      // so the local default applies again instead of a stale stored value.
      const cleared = await admin.saveConfig({ task_timeout_s: null, default_reasoning_effort: null, executor: null });
      expect(cleared.advanced.task_timeout_s).toBeNull();
      expect(cleared.advanced.default_reasoning_effort).toBeNull();
      expect(cleared.advanced.executor).toBeNull();
      const clearedConfig = JSON.parse(await readFile(configPath(root), "utf8")) as Record<string, unknown>;
      expect(clearedConfig["task_timeout_s"]).toBeUndefined();
      expect(clearedConfig["default_reasoning_effort"]).toBeUndefined();
      // Clearing the executor falls back to the plugin default (acp), which is
      // written back so the persisted node config never loses it.
      expect(clearedConfig["executor"]).toBe("acp");
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("full reset deletes both configs and returns to the wizard", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      await handle.reconfigure({ display_name: "before reset", peers: [] });
      const before = handle.runtime.orcaNode!.self().orca_node_id;
      expect(handle.uiConfigured).toBe(true);

      await handle.reset();

      expect(handle.uiConfigured).toBe(false);
      expect(handle.config.workgroup_id).toBe("wg-panel");
      expect(handle.runtime.error).toBeNull();
      // Reset returns to the wizard: nothing restarts until setup completes.
      expect(handle.runtime.orcaNode).toBeNull();
      await expect(readFile(overridePath(root), "utf8")).rejects.toThrow();
      await expect(readFile(configPath(root), "utf8")).rejects.toThrow();

      const view = await adminFor(handle).saveConfig({ workgroup_password: "panel-password" });
      expect(view.running).toBe(true);
      expect(handle.runtime.orcaNode!.self().orca_node_id).not.toBe(before);
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("reloads the override and keeps the orca node id on the next start", async () => {
    const root = await tempRoot("orca-panel-");
    const first = await startedPod(baseConfig(root));
    const firstId = first.runtime.orcaNode!.self().orca_node_id;
    await stopPod(first, logger);

    const second = startPod(baseConfig(root), logger);
    await second.ready;
    try {
      expect(second.uiConfigured).toBe(true);
      expect(second.runtime.error).toBeNull();
      expect(second.runtime.orcaNode!.self().orca_node_id).toBe(firstId);
    } finally {
      await stopPod(second, logger);
    }
  });

  it("joins a peer live and persists it into the override", async () => {
    const rootA = await tempRoot("orca-panel-a-");
    const rootB = await tempRoot("orca-panel-b-");
    const a = await startedPod(baseConfig(rootA));
    const b = await startedPod(baseConfig(rootB));
    try {
      const peerUrl = b.runtime.url!;
      await a.addPeer(peerUrl);
      expect(a.config.peers).toContain(peerUrl);
      const stored = JSON.parse(await readFile(overridePath(rootA), "utf8")) as Record<string, unknown>;
      expect(stored["setup_complete"]).toBe(true);
      expect(stored["peers"]).toEqual([peerUrl]);
    } finally {
      await stopPod(a, logger);
      await stopPod(b, logger);
    }
  });

  it("rejoins the remembered peers when the node starts", async () => {
    const rootA = await tempRoot("orca-panel-a-");
    const rootB = await tempRoot("orca-panel-b-");
    const b = await startedPod(baseConfig(rootB));
    try {
      const peerUrl = b.runtime.url!;
      // `peers` is what the previous session left behind; startup should try it
      // once without waiting for the operator to click Connect again.
      const a = await startedPod({ ...baseConfig(rootA), peers: [peerUrl] });
      await a.ready;
      try {
        const want = b.runtime.orcaNode!.self().orca_node_id;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (a.runtime.orcaNode!.members().some((member) => member.state === "online")) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        const members = a.runtime.orcaNode!.members();
        expect(members.map((member) => member.orca_node_id)).toContain(want);
      } finally {
        await stopPod(a, logger);
      }
    } finally {
      await stopPod(b, logger);
    }
  });

  it("does not remember a peer that cannot be joined", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = await startedPod(baseConfig(root));
    try {
      await expect(handle.addPeer("http://127.0.0.1:1")).rejects.toThrow();
      expect(handle.config.peers).toEqual([]);
      // The failed join must not add a peer to the persisted override: only the
      // setup marker is there.
      const stored = JSON.parse(await readFile(overridePath(root), "utf8")) as Record<string, unknown>;
      expect(stored["peers"]).toBeUndefined();
    } finally {
      await stopPod(handle, logger);
    }
  });
});

describe("panel admin configuration", () => {
  it("never exposes the workgroup password", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = await startedPod(baseConfig(root));
    try {
      const view = adminFor(handle).config();
      expect(view).toMatchObject({
        configured: true,
        workgroup_id: "wg-panel",
        password_set: true,
        running: true,
        error: null,
      });
      expect(JSON.stringify(view)).not.toContain("panel-password");
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("switches the workgroup with the existing password", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = await startedPod(baseConfig(root));
    try {
      const admin = adminFor(handle);
      const firstId = handle.runtime.orcaNode!.self().orca_node_id;

      const view = await admin.saveConfig({ workgroup_id: "wg-other" });

      expect(view.workgroup_id).toBe("wg-other");
      expect(view.password_set).toBe(true);
      expect(handle.config.workgroup_password).toBe("panel-password");
      expect(handle.runtime.orcaNode!.self().orca_node_id).toBe(firstId);
      const stored = JSON.parse(await readFile(configPath(root), "utf8")) as Record<string, unknown>;
      expect(stored["workgroup_id"]).toBe("wg-other");
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("normalizes peers before joining them", async () => {
    const seen: string[] = [];
    const handle: PodHandle = {
      ready: Promise.resolve(),
      runtime: { orcaNode: null, url: null, port: null, started_at: null, error: null },
      config: {
        workgroup_id: "wg-panel",
        workgroup_password: "pw",
        port: 11811,
        skill_injection: false,
        peers: [],
      },
      uiConfigured: false,
      reconfigure: async () => {},
      addPeer: async (peer) => {
        seen.push(peer);
      },
      disconnect: async () => {},
        reset: async () => {},
    };
    const admin = adminFor(handle);
    await admin.connect("192.168.1.20:11811");
    await admin.connect("http://desk.example.com/");
    expect(seen).toEqual(["http://192.168.1.20:11811", "http://desk.example.com:80"]);
    expect(normalizePeer("10.0.0.2")).toBe("http://10.0.0.2:11811");
    expect(normalizePeer("10.0.0.2:11811")).toBe("http://10.0.0.2:11811");
    expect(normalizePeer("http://10.0.0.2:11811/")).toBe("http://10.0.0.2:11811");
    expect(normalizePeer("https://desk.example.com")).toBe("https://desk.example.com:443");
    expect(normalizePeer("http://desk.example.com")).toBe("http://desk.example.com:80");
    expect(normalizePeer("[fd00::12]")).toBe("http://[fd00::12]:11811");
    expect(normalizePeer("[fd00::12]:11811")).toBe("http://[fd00::12]:11811");
    expect(normalizePeer("fd00::12")).toBe("http://[fd00::12]:11811");
    expect(normalizePeer("http://[fd00::12]:11811")).toBe("http://[fd00::12]:11811");
    expect(() => normalizePeer("")).toThrow(/peer address is required/);
    expect(() => normalizePeer("http://")).toThrow(/must include a host/);
    expect(() => normalizePeer("http://desk.example.com/a2a")).toThrow(/without a path/);
    expect(() => normalizePeer("http://desk.example.com?x=1")).toThrow(/without a path/);
    expect(() => normalizePeer("10.0.0.2:0")).toThrow(/invalid peer port/);
    expect(() => normalizePeer("10.0.0.2:99999")).toThrow(/invalid peer port/);
    expect(() => normalizePeer("10.0.0.2:abc")).toThrow(/invalid peer port/);
  });

  it("defaults the display name to the orca node id and suggests local endpoints", async () => {
    const root = await tempRoot("orca-panel-");
    const config: Config = {
      workgroup_id: "wg-id",
      workgroup_password: "pw",
      port: 0,
      skill_injection: false,
      peers: [],
      data_root: root,
    };
    const handle = await startedPod(config);
    try {
      const admin = adminFor(handle);
      const self = admin.self()!;
      expect(self.display_name).toBe(shortenNodeId(self.orca_node_id));
      expect(admin.config().display_name).toBe(shortenNodeId(self.orca_node_id));
      const detected = admin.config().detected_endpoints;
      expect(Array.isArray(detected)).toBe(true);
      for (const url of detected) expect(url.startsWith("http://")).toBe(true);
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("stays idle until the first-run wizard supplies a workgroup", async () => {
    const root = await tempRoot("orca-panel-");
    const config: Config = {
      workgroup_id: "",
      workgroup_password: "",
      port: 0,
      skill_injection: false,
      peers: [],
      data_root: root,
    };
    const handle = startPod(config, logger);
    await handle.ready;
    try {
      const admin = adminFor(handle);
      expect(handle.runtime.orcaNode).toBeNull();
      expect(handle.runtime.error).toBeNull();
      expect(admin.config().configured).toBe(false);
      expect(admin.config().running).toBe(false);

      await admin.saveConfig({ workgroup_id: "wg-fresh", workgroup_password: "pw-fresh" });

      expect(handle.runtime.orcaNode).not.toBeNull();
      expect(handle.runtime.error).toBeNull();
      expect(handle.uiConfigured).toBe(true);
      expect(admin.config()).toMatchObject({ configured: true, running: true, workgroup_id: "wg-fresh" });
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("keeps the node idle while the workgroup password is missing", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod({ ...baseConfig(root), workgroup_password: "" }, logger);
    await handle.ready;
    try {
      const view = adminFor(handle).config();
      expect(view.running).toBe(false);
      expect(view.configured).toBe(false);
      expect(view.password_set).toBe(false);
      expect(view.error).toBeNull();
      expect(handle.runtime.orcaNode).toBeNull();
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("rejects saving a blank workgroup password", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      await expect(adminFor(handle).saveConfig({ workgroup_password: "" })).rejects.toThrow(
        /password is required/,
      );
      await expect(adminFor(handle).saveConfig({ workgroup_password: "   " })).rejects.toThrow(
        /password is required/,
      );
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("disconnects: leaves known peers and forgets them", async () => {
    const rootA = await tempRoot("orca-panel-a-");
    const rootB = await tempRoot("orca-panel-b-");
    const a = await startedPod(baseConfig(rootA, "wg-leave"));
    const b = await startedPod(baseConfig(rootB, "wg-leave"));
    try {
      await a.addPeer(b.runtime.url!);
      expect(a.config.peers).toHaveLength(1);
      const admin = adminFor(a);
      await admin.disconnect();
      expect(a.config.peers).toEqual([]);
      const stored = JSON.parse(await readFile(overridePath(rootA), "utf8")) as Record<string, unknown>;
      expect(stored["peers"]).toEqual([]);
      const remaining = admin.members().map((member) => member.orca_node_id);
      expect(remaining).toEqual([]);
    } finally {
      await stopPod(a, logger);
      await stopPod(b, logger);
    }
  });
});
