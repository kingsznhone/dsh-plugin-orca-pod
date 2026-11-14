import { describe, expect, it } from "vitest";

import { createMesh } from "../src/index.ts";

describe("createMesh", () => {
  it("joins three nodes into one converged mesh", async () => {
    const mesh = await createMesh({ nodes: 3 });
    try {
      expect(mesh.nodes).toHaveLength(3);
      expect(mesh.urls).toHaveLength(3);

      for (const node of mesh.nodes) {
        expect(node.members()).toHaveLength(2);
      }

      const digests = new Set(mesh.nodes.map((node) => node.membersDigest()));
      expect(digests.size).toBe(1);

      for (const url of mesh.urls) {
        const response = await fetch(`${url}/health`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { status: string };
        expect(body.status).toBe("ok");
      }
    } finally {
      await mesh.stop();
    }
  });
});
