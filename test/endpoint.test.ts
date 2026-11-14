import { describe, expect, it } from "vitest";

import { createOrcaNodeConfig, endpointWriteback, validateConfig } from "../src/config.ts";

describe("serve endpoint writeback", () => {
  it("keeps explicitly configured public endpoints", () => {
    const config = createOrcaNodeConfig({
      workgroupId: "endpoint-test",
      password: "correct horse",
      dataRoot: "endpoint-test-root",
      port: 0,
      endpoints: ["https://a.example.com", "http://192.168.1.10:11811"],
    });

    const next = endpointWriteback(config, "http://127.0.0.1:54321");

    expect(next?.endpoints).toEqual(["https://a.example.com", "http://192.168.1.10:11811"]);
    expect(next?.bind.port).toBe(54321);
  });

  it("learns the listen address when no endpoint is configured", () => {
    const config = createOrcaNodeConfig({
      workgroupId: "endpoint-test",
      password: "correct horse",
      dataRoot: "endpoint-test-root",
      port: 0,
    });

    const next = endpointWriteback(config, "http://127.0.0.1:54321");

    expect(next?.endpoints).toEqual(["http://127.0.0.1:54321"]);
    expect(next?.bind.port).toBe(54321);
  });

  it("writes nothing when endpoints and port are already known", () => {
    const config = createOrcaNodeConfig({
      workgroupId: "endpoint-test",
      password: "correct horse",
      dataRoot: "endpoint-test-root",
      port: 11811,
      endpoints: ["https://a.example.com"],
    });

    expect(endpointWriteback(config, "http://127.0.0.1:11811")).toBeNull();
  });
});

describe("config endpoint validation", () => {
  it("accepts an empty list (it is learned on first serve) but rejects bad entries", () => {
    const config = createOrcaNodeConfig({
      workgroupId: "endpoint-test",
      password: "correct horse",
      dataRoot: "endpoint-test-root",
      port: 11811,
    });
    expect(validateConfig({ ...config, endpoints: [] }).endpoints).toEqual([]);
    expect(() => validateConfig({ ...config, endpoints: ["not a url"] })).toThrow(/endpoints/);
    expect(() => createOrcaNodeConfig({
      workgroupId: "endpoint-test",
      password: "correct horse",
      dataRoot: "endpoint-test-root",
      port: 11811,
      endpoints: ["ftp://example.com"],
    })).toThrow(/endpoints/);
  });
});
