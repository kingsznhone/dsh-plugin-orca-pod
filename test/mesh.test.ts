import { describe, expect, it } from "vitest";

import { createMesh } from "../src/node/harness.ts";

describe("createMesh", () => {
  it("joins three orca nodes into one converged mesh", async () => {
    const mesh = await createMesh({ orcaNodes: 3 });
    try {
      expect(mesh.orcaNodes).toHaveLength(3);
      expect(mesh.urls).toHaveLength(3);

      for (const orcaNode of mesh.orcaNodes) {
        expect(orcaNode.members()).toHaveLength(2);
      }

      const digests = new Set(mesh.orcaNodes.map((orcaNode) => orcaNode.membersDigest()));
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
