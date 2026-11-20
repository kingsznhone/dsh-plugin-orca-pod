import { describe, expect, it } from "vitest";

import { nodeFetch } from "../src/mesh/peer-client.ts";
import { PeerTls } from "../src/mesh/tls.ts";
import { createMesh } from "./support/harness.ts";
import { peersOf } from "./support/node.ts";

describe("createMesh", () => {
  it("joins three orca nodes into one converged mesh", async () => {
    const mesh = await createMesh({ orcaNodes: 3 });
    try {
      expect(mesh.orcaNodes).toHaveLength(3);
      expect(mesh.urls).toHaveLength(3);

      for (const orcaNode of mesh.orcaNodes) {
        expect(peersOf(orcaNode)).toHaveLength(2);
      }

      const digests = new Set(mesh.orcaNodes.map((orcaNode) => orcaNode.mesh.digest()));
      expect(digests.size).toBe(1);

      // Each node serves https with its own certificate; a first-contact route takes any node's.
      const tls = new PeerTls();
      for (const url of mesh.urls) {
        expect(url).toMatch(/^https:\/\//);
        const route = tls.route("");
        const response = await nodeFetch(new URL("/health", url), { dispatcher: route.dispatcher });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { status: string };
        expect(body.status).toBe("ok");
        route.release();
      }
    } finally {
      await mesh.stop();
    }
  });
});
