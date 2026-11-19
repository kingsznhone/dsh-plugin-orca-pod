import { describe, expect, it } from "vitest";

import { PanelPatchSchema, parseSettings } from "../src/node/settings.ts";

describe("settings parser", () => {
  it("treats null like absent so a patch can clear a field", () => {
    expect(parseSettings({ port: null, task_timeout_s: null, display_name: null })).toEqual(parseSettings({}));
  });

  it("reports every invalid field with its key", () => {
    const problems = () =>
      parseSettings({ port: "11811", task_timeout_s: -1, permission_mode: "nope", max_workspace_bytes: 1.5 });
    expect(problems).toThrow(/^invalid config: /);
    for (const key of ["max_workspace_bytes", "permission_mode", "port", "task_timeout_s"]) {
      expect(problems).toThrow(new RegExp(`(: |; )${key}: `));
    }
  });

  it("points an issue at the nested value and names the allowed values", () => {
    const problems = () => parseSettings({ acp: { command: "" }, permission_mode: "nope", port: 70000 });
    expect(problems).toThrow(/port: [^;]*<=65535/);
    expect(problems).toThrow(/permission_mode: [^;]*"read-only"\|"workspace-write"/);
    expect(problems).toThrow(/acp\.command: [^;]*>=1 characters/);
  });

  it("drops keys a nested setting does not describe", () => {
    const raw = { acp: { command: "dsh", extra: true, mcp_servers: [{ name: "fs", command: "x" }] } };
    expect(parseSettings(raw).acp).toEqual({ command: "dsh" });
    expect(raw.acp).toHaveProperty("extra", true);
  });

  it("canonicalizes peers and rejects what is not an address", () => {
    expect(parseSettings({ peers: ["10.0.0.2", "http://10.0.0.2:11811/", "[fd00::1]:9000"] }).peers).toEqual([
      "http://10.0.0.2:11811",
      "http://[fd00::1]:9000",
    ]);
    expect(() => parseSettings({ peers: ["not a url"] })).toThrow(/peers/);
  });

  it("keeps panel-editable keys only, nulls included, and checks their values", () => {
    expect(
      PanelPatchSchema.parse({
        display_name: "x",
        task_timeout_s: null,
        data_root: "/etc",
        acp: {},
        skill_injection: true,
        other: 1,
      }),
    ).toEqual({ display_name: "x", task_timeout_s: null });
    expect(PanelPatchSchema.safeParse({ port: "11812" }).success).toBe(false);
  });

  it("never holds the workgroup password: it is a panel input for the credential store", () => {
    const settings = parseSettings({ workgroup_id: "wg-a", workgroup_password: "pw", skill_injection: true });
    expect(settings).not.toHaveProperty("workgroup_password");
    expect(settings).not.toHaveProperty("skill_injection");
    expect(PanelPatchSchema.parse({ workgroup_password: "pw" })).toEqual({ workgroup_password: "pw" });
  });
});
