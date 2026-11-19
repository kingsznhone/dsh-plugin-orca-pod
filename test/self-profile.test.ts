import { describe, expect, it, vi } from "vitest";

import type { RuntimeInfo } from "../src/mesh/wire.ts";
import { type NodeInput, newNode } from "./support/node.ts";
import { wg, labelId } from "./fixtures/ids.ts";

const RUNTIME: RuntimeInfo = {
  os: { family: "linux", name: "Linux", version: "6" },
  arch: "x64",
  cpu: { model: "test", logical_cores: 2 },
  memory: { total_bytes: 1 },
  node: { version: "v24" },
  captured_at: "2026-01-01T00:00:00.000Z",
};

/** A node that was not started: its own row of the table is what it says about itself. */
function node(overrides: Partial<NodeInput> = {}) {
  return newNode({ workgroup_id: wg("grp"), workgroup_password: "pw", port: 0, ...overrides }, { runtime: RUNTIME });
}

describe("this node as a row of its own table", () => {
  it("shows the node id as the name until a display name is set", () => {
    const unnamed = node();
    expect(unnamed.mesh.self.view().display_name).toBe(
      unnamed.mesh.self.id.slice(0, 6) + "…" + unnamed.mesh.self.id.slice(-4),
    );
    expect(node({ display_name: "alpha" }).mesh.self.view().display_name).toBe("alpha");
  });

  it("is online, is itself, and is in the table", () => {
    const orca = node();
    const { self } = orca.mesh;
    expect(self.isSelf).toBe(true);
    expect(self.state).toBe("online");
    expect(orca.mesh.get(orca.mesh.self.id)).toBe(self);
    expect(orca.mesh.peers()).toEqual([]);
  });

  it("advertises the endpoints it was told about, and the task holding its slot", () => {
    const orca = node({
      bind_host: "10.0.0.2",
      port: 11811,
      endpoints: ["http://10.0.0.2:11811", "http://127.0.0.1:11811"],
    });
    const { self } = orca.mesh;
    expect(self.endpoints).toEqual(["http://10.0.0.2:11811", "http://127.0.0.1:11811"]);
    expect(self.view().busy).toBeNull();
    const busy = { task_id: "t1", origin_orca_node: labelId("OTHER"), since: "2026-01-01T00:00:00.000Z" };
    const slot = vi.spyOn(orca.tasks, "busy").mockReturnValue(busy);
    expect(self.view().busy).toEqual(busy);
    slot.mockReturnValue(null);
    expect(self.selfRecord().busy).toBeNull();
  });

  it("follows its model catalog when the catalog changes, and advertises the task budget it was given", () => {
    const orca = node({ task_timeout_s: 90 });
    expect(orca.mesh.self.view().models).toBeUndefined();
    expect(orca.mesh.self.view().max_task_ttl_s).toBe(90);
    orca.models.update([{ provider: "p", id: "m", name: "M" }], null);
    expect(orca.mesh.self.view().models?.map((offer) => offer.id)).toEqual(["m"]);
  });

  it("answers as a self record with its workgroup", () => {
    const orca = node();
    expect(orca.mesh.self.selfRecord()).toMatchObject({
      orca_node_id: orca.mesh.self.id,
      workgroup_id: wg("grp"),
      state: "online",
    });
  });
});
