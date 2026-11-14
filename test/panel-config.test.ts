/**
 * Panel-driven configuration (§9.2): the `ui-config.json` override, live
 * reconfiguration, peer joins from the UI, and the admin read model that never
 * exposes the workgroup password.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

describe("panel override lifecycle", () => {
  it("starts unconfigured, then records and applies a reconfigure", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      expect(handle.uiConfigured).toBe(false);
      expect(handle.runtime.error).toBeNull();
      const firstId = handle.runtime.orcaNode!.self().orca_node_id;

      await handle.reconfigure({ display_name: "renamed node", peers: [] });

      expect(handle.uiConfigured).toBe(true);
      expect(handle.config.display_name).toBe("renamed node");
      expect(handle.runtime.error).toBeNull();
      expect(handle.runtime.orcaNode!.self().orca_node_id).toBe(firstId);

      const stored = JSON.parse(await readFile(overridePath(root), "utf8")) as Record<string, unknown>;
      expect(stored["setup_complete"]).toBe(true);
      expect(stored["display_name"]).toBe("renamed node");
    } finally {
      await stopPod(handle, logger);
    }
  });

  it("reloads the override and keeps the orca node id on the next start", async () => {
    const root = await tempRoot("orca-panel-");
    const first = startPod(baseConfig(root), logger);
    await first.ready;
    const firstId = first.runtime.orcaNode!.self().orca_node_id;
    await first.reconfigure({ peers: [] });
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
    const a = startPod(baseConfig(rootA), logger);
    await a.ready;
    const b = startPod(baseConfig(rootB), logger);
    await b.ready;
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

  it("does not remember a peer that cannot be joined", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      await expect(handle.addPeer("http://127.0.0.1:1")).rejects.toThrow();
      expect(handle.config.peers).toEqual([]);
      await expect(readFile(overridePath(root), "utf8")).rejects.toThrow();
    } finally {
      await stopPod(handle, logger);
    }
  });
});

describe("panel admin configuration", () => {
  it("never exposes the workgroup password", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      const view = adminFor(handle).config();
      expect(view).toMatchObject({
        configured: false,
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

  it("requires the password when the panel switches workgroup", async () => {
    const root = await tempRoot("orca-panel-");
    const handle = startPod(baseConfig(root), logger);
    await handle.ready;
    try {
      const admin = adminFor(handle);
      await expect(admin.saveConfig({ workgroup_id: "wg-other" })).rejects.toThrow(
        /requires its password/,
      );
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
    };
    const admin = adminFor(handle);
    await admin.connect("192.168.1.20:11811");
    await admin.connect("http://desk.example.com/");
    expect(seen).toEqual(["http://192.168.1.20:11811", "http://desk.example.com"]);
    expect(normalizePeer("10.0.0.2:11811")).toBe("http://10.0.0.2:11811");
  });
});
