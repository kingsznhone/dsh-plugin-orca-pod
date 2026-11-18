import { describe, expect, it } from "vitest";

import { ModelCatalog } from "../src/core/model-catalog.ts";
import type { RuntimeInfo } from "../src/core/wire/peer.ts";
import { SelfProfile } from "../src/mesh/self-profile.ts";
import { labelId, wg } from "./fixtures/ids.ts";

const RUNTIME: RuntimeInfo = {
  os: { family: "linux", name: "Linux", version: "6" },
  arch: "x64",
  cpu: { model: "test", logical_cores: 2 },
  memory: { total_bytes: 1 },
  node: { version: "v24" },
  captured_at: "2026-01-01T00:00:00.000Z",
};

function profile(config: { display_name?: string; task_timeout_s?: number } = {}, models = new ModelCatalog()) {
  return new SelfProfile(
    { orca_node_id: labelId("SELF"), workgroup_id: wg("grp"), display_name: config.display_name ?? "", ...config },
    RUNTIME,
    models,
  );
}

describe("SelfProfile", () => {
  it("shows the node id as the name until a display name is set", () => {
    expect(profile().peer().display_name).toBe(labelId("SELF"));
    expect(profile({ display_name: "alpha" }).peer().display_name).toBe("alpha");
  });

  it("advertises the endpoints and the busy holder it was told about", () => {
    const self = profile();
    expect(self.peer().endpoints).toEqual([]);
    self.setEndpoints(["http://10.0.0.2:11811", "http://127.0.0.1:11811"]);
    expect(self.endpoints).toEqual(["http://10.0.0.2:11811", "http://127.0.0.1:11811"]);
    expect(self.peer().busy).toBeNull();
    const busy = { task_id: "t1", origin_orca_node: labelId("OTHER"), since: "2026-01-01T00:00:00.000Z" };
    self.setBusy(busy);
    expect(self.peer().busy).toEqual(busy);
    expect(self.description()).not.toHaveProperty("busy");
    self.setBusy(null);
    expect(self.record().busy).toBeNull();
  });

  it("reads its model catalog live and its task budget from the config", () => {
    const models = new ModelCatalog();
    const self = profile({ task_timeout_s: 90 }, models);
    expect(self.peer().models).toBeUndefined();
    models.update([{ provider: "p", id: "m", name: "M" }], null);
    expect(self.peer().models?.map((offer) => offer.id)).toEqual(["m"]);
    expect(self.description().models?.map((offer) => offer.id)).toEqual(["m"]);
    expect(self.peer().max_task_ttl_s).toBe(90);
    expect(profile().peer().max_task_ttl_s).toBe(3600);
  });

  it("answers as a self record with its workgroup", () => {
    expect(profile().record()).toMatchObject({
      orca_node_id: labelId("SELF"),
      workgroup_id: wg("grp"),
      state: "online",
    });
  });
});
