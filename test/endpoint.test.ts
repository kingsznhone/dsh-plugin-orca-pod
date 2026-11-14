import { describe, expect, it } from "vitest";

import { createOrcaNodeConfig, endpointWriteback } from "../src/config.ts";

describe("serve endpoint writeback", () => {
  it("keeps an explicitly configured public endpoint", () => {
    const config = createOrcaNodeConfig({
      workgroupId: "endpoint-test",
      password: "correct horse",
      dataRoot: "endpoint-test-root",
      port: 0,
      endpoint: "https://a.example.com",
    });

    const next = endpointWriteback(config, "http://127.0.0.1:54321");

    expect(next?.endpoint).toBe("https://a.example.com");
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

    expect(next?.endpoint).toBe("http://127.0.0.1:54321");
    expect(next?.bind.port).toBe(54321);
  });

  it("writes nothing when endpoint and port are already known", () => {
    const config = createOrcaNodeConfig({
      workgroupId: "endpoint-test",
      password: "correct horse",
      dataRoot: "endpoint-test-root",
      port: 11811,
      endpoint: "https://a.example.com",
    });

    expect(endpointWriteback(config, "http://127.0.0.1:11811")).toBeNull();
  });
});
