import { describe, expect, it } from "vitest";

import { signGrant, GrantLedger, parseSignedGrant, type GrantExpectation } from "../src/task/grants.ts";
import { generateNodeIdentity } from "../src/core/identity.ts";
import type { Grant, PermissionRequest } from "../src/core/wire/grant.ts";

import { fakeNodeId, wg } from "./fixtures/ids.ts";

const origin = generateNodeIdentity();
const SELF = fakeNodeId("SELF");

const pending: PermissionRequest = {
  request_id: "req-1",
  task_id: "task-1",
  tool: "write_file",
  requested: {},
  requested_by: SELF,
  current_mode: "read-only",
  requested_mode: "workspace-write",
};

const expected: GrantExpectation = {
  taskId: "task-1",
  selfOrcaNodeId: SELF,
  workgroupId: wg("wg"),
  origin: origin.orcaNodeId,
  pending,
};

function grant(overrides: Partial<Grant> = {}) {
  return signGrant(origin, {
    grant_id: "g-1",
    workgroup_id: wg("wg"),
    origin_orca_node: origin.orcaNodeId,
    task_id: "task-1",
    target_orca_node: SELF,
    tool: "write_file",
    permission_mode: "workspace-write",
    request_id: "req-1",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

describe("GrantLedger.accept", () => {
  it("accepts a grant once: the first use is remembered, a second one is a replay", () => {
    const ledger = new GrantLedger();
    const signed = grant();
    expect(ledger.accept(signed, expected)).toBeNull();
    expect(ledger.accept(signed, expected)).toBe("grant_replayed");
  });

  it("does not remember a grant it rejected", () => {
    const ledger = new GrantLedger();
    expect(ledger.accept(grant(), { ...expected, taskId: "another-task" })).toBe("grant_invalid");
    expect(ledger.accept(grant(), expected)).toBeNull();
  });

  it("rejects a grant that is expired, for another tool, request, workgroup or origin", () => {
    const ledger = new GrantLedger();
    expect(ledger.accept(grant({ expires_at: new Date(Date.now() - 1000).toISOString() }), expected)).toBe(
      "grant_expired",
    );
    expect(ledger.accept(grant({ tool: "delete" }), expected)).toBe("grant_invalid");
    // The origin grants exactly the mode the task asked for, no wider.
    expect(ledger.accept(grant({ permission_mode: "danger-full-access" }), expected)).toBe("grant_invalid");
    expect(ledger.accept(grant({ request_id: "other" }), expected)).toBe("grant_invalid");
    expect(ledger.accept(grant({ workgroup_id: wg("elsewhere") }), expected)).toBe("grant_invalid");
    expect(ledger.accept(grant(), { ...expected, origin: fakeNodeId("SOMEONE-ELSE") })).toBe("grant_invalid");
    expect(ledger.accept({ ...grant(), sig: "forged" }, expected)).toBe("grant_invalid");
  });

  it("only accepts a grant for this very task on this very node", () => {
    const ledger = new GrantLedger();
    expect(ledger.accept(grant({ task_id: "another-task" }), expected)).toBe("grant_invalid");
    expect(ledger.accept(grant({ target_orca_node: fakeNodeId("STRANGER") }), expected)).toBe("grant_invalid");
  });
});

describe("boundary parsers", () => {
  it("parses a grant once and rejects malformed ones", () => {
    const signed = grant();
    expect(parseSignedGrant(JSON.parse(JSON.stringify(signed)))).toEqual(signed);
    expect(() => parseSignedGrant("nope")).toThrowError(/expected object/);
    expect(() => parseSignedGrant({ ...signed, request_id: "" })).toThrowError(/request_id/);
    expect(() => parseSignedGrant({ ...signed, sig: undefined })).toThrowError(/sig/);
    expect(() => parseSignedGrant({ ...signed, expires_at: "soon" })).toThrowError(/expires_at/);
    expect(() => parseSignedGrant({ ...signed, permission_mode: "root" })).toThrowError(/permission_mode/);
  });
});
