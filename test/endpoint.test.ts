import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createOrcaNodeConfig, endpointWriteback, validateConfig } from "../src/node/config.ts";

// A scratch data root per test file: the identity file must never land in the
// repository (it used to leave an untracked `endpoint-test-root/` behind).
const dataRoot = mkdtempSync(join(tmpdir(), "orca-endpoint-"));
afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));

describe("serve endpoint writeback", () => {
  it("keeps explicitly configured public endpoints", () => {
    const config = createOrcaNodeConfig({
      workgroup_id: "endpoint-test",
      workgroup_password: "correct horse",
      data_root: dataRoot,
      port: 0,
      endpoints: ["https://a.example.com", "http://192.168.1.10:11811"],
    });

    const next = endpointWriteback(config, "http://127.0.0.1:54321");

    expect(next?.endpoints).toEqual(["https://a.example.com", "http://192.168.1.10:11811"]);
    expect(next?.port).toBe(54321);
  });

  it("learns the listen address when no endpoint is configured", () => {
    const config = createOrcaNodeConfig({
      workgroup_id: "endpoint-test",
      workgroup_password: "correct horse",
      data_root: dataRoot,
      port: 0,
    });

    const next = endpointWriteback(config, "http://127.0.0.1:54321");

    expect(next?.endpoints).toEqual(["http://127.0.0.1:54321"]);
    expect(next?.port).toBe(54321);
  });

  it("writes nothing when endpoints and port are already known", () => {
    const config = createOrcaNodeConfig({
      workgroup_id: "endpoint-test",
      workgroup_password: "correct horse",
      data_root: dataRoot,
      port: 11811,
      endpoints: ["https://a.example.com"],
    });

    expect(endpointWriteback(config, "http://127.0.0.1:11811")).toBeNull();
  });
});

describe("config endpoint validation", () => {
  it("accepts an empty list (it is learned on first serve) but rejects bad entries", () => {
    const config = createOrcaNodeConfig({
      workgroup_id: "endpoint-test",
      workgroup_password: "correct horse",
      data_root: dataRoot,
      port: 11811,
    });
    expect(validateConfig({ ...config, endpoints: [] }).endpoints).toEqual([]);
    expect(() => validateConfig({ ...config, endpoints: ["not a url"] })).toThrow(/endpoints/);
    expect(() =>
      createOrcaNodeConfig({
        workgroup_id: "endpoint-test",
        workgroup_password: "correct horse",
        data_root: dataRoot,
        port: 11811,
        endpoints: ["ftp://example.com"],
      }),
    ).toThrow(/endpoints/);
  });
});
