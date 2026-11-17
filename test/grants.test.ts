import { describe, expect, it } from "vitest";

import { signGrant } from "../src/security/crypto.ts";
import {
  checkGrant,
  createGrantLedger,
  parseSignedGrant,
  parseTaskRelay,
  type GrantExpectation,
} from "../src/security/grants.ts";
import { generateNodeIdentity } from "../src/security/identity.ts";
import type { Grant, PermissionRequest } from "../src/protocol/grant.ts";

import { fakeNodeId, wg } from "./fixtures/ids.ts";

const origin = generateNodeIdentity();
const SELF = fakeNodeId("SELF");

const pending: PermissionRequest = {
  request_id: "req-1",
  task_id: "task-1",
  tool: "write_file",
  requested: {},
  requested_by: SELF,
  via: [origin.orcaNodeId],
};

const expected: GrantExpectation = {
  taskId: "task-1",
  selfOrcaNodeId: SELF,
  workgroupId: wg("wg"),
  rootOrigin: origin.orcaNodeId,
  chain: [origin.orcaNodeId],
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
    mode: "allow_once",
    chain: [origin.orcaNodeId],
    request_id: "req-1",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

describe("checkGrant", () => {
  it("verifies without consuming: only the ledger records a use", () => {
    const ledger = createGrantLedger();
    const signed = grant();
    expect(checkGrant(signed, expected, ledger)).toBeNull();
    expect(checkGrant(signed, expected, ledger)).toBeNull();

    ledger.consume(signed);
    expect(checkGrant(signed, expected, ledger)).toBe("grant_replayed");
  });

  it("rejects a grant that is expired, for another tool, request, workgroup or origin", () => {
    const ledger = createGrantLedger();
    expect(checkGrant(grant({ expires_at: new Date(Date.now() - 1000).toISOString() }), expected, ledger)).toBe(
      "grant_expired",
    );
    expect(checkGrant(grant({ tool: "delete" }), expected, ledger)).toBe("grant_invalid");
    expect(checkGrant(grant({ request_id: "other" }), expected, ledger)).toBe("grant_invalid");
    expect(checkGrant(grant({ workgroup_id: wg("elsewhere") }), expected, ledger)).toBe("grant_invalid");
    expect(checkGrant(grant(), { ...expected, rootOrigin: fakeNodeId("SOMEONE-ELSE") }, ledger)).toBe("grant_invalid");
    expect(checkGrant({ ...grant(), sig: "forged" }, expected, ledger)).toBe("grant_invalid");
  });

  it("accepts a grant signed for an ancestor of the chain and refuses an unrelated target", () => {
    const ledger = createGrantLedger();
    const middle = fakeNodeId("MIDDLE");
    const chained = { ...expected, chain: [origin.orcaNodeId, middle] };
    const forwarded = grant({
      task_id: "parent-task",
      target_orca_node: middle,
      chain: [origin.orcaNodeId, origin.orcaNodeId],
    });
    expect(checkGrant(forwarded, chained, ledger)).toBeNull();
    expect(checkGrant(grant({ target_orca_node: fakeNodeId("STRANGER") }), chained, ledger)).toBe("grant_invalid");
  });
});

describe("boundary parsers", () => {
  it("parses a grant once and rejects malformed ones", () => {
    const signed = grant();
    expect(parseSignedGrant(JSON.parse(JSON.stringify(signed)))).toEqual(signed);
    expect(() => parseSignedGrant("nope")).toThrowError(/expected object/);
    expect(() => parseSignedGrant({ ...signed, chain: [] })).toThrowError(/chain/);
    expect(() => parseSignedGrant({ ...signed, sig: undefined })).toThrowError(/sig/);
    expect(() => parseSignedGrant({ ...signed, expires_at: "soon" })).toThrowError(/expires_at/);
    expect(() => parseSignedGrant({ ...signed, mode: "forever" })).toThrowError(/mode/);
  });

  it("parses a relay and reports its failures with the caller's error code", () => {
    const relay = { peer: "http://x", task_id: "c1", request: { ...pending, task_id: "c1" } };
    expect(parseTaskRelay(relay).request.tool).toBe("write_file");
    expect(() => parseTaskRelay({ ...relay, peer: "" })).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => parseTaskRelay({ ...relay, extra: 1 }, "relay", "bad_echo_script")).toThrowError(
      expect.objectContaining({ code: "bad_echo_script" }),
    );
    expect(() => parseTaskRelay({ ...relay, request: { ...relay.request, via: "A" } })).toThrowError(/via/);
  });
});
