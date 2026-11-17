import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { createOrcaNode, type OrcaNode } from "../src/node/orca-node.ts";

const LIVE: OrcaNode[] = [];

afterEach(async () => {
  for (const node of LIVE.splice(0)) await node.stop();
});

async function pair(): Promise<[OrcaNode, OrcaNode]> {
  const workgroupId = `wg-${randomBytes(6).toString("hex")}`;
  const nodes = [0, 1].map(() =>
    createOrcaNode({
      config: createOrcaNodeConfig({
        workgroup_id: workgroupId,
        workgroup_password: "same password",
        data_root: mkdtempSync(join(tmpdir(), "orca-self-")),
        port: 0,
      }),
    }),
  );
  for (const node of nodes) {
    await node.start();
    LIVE.push(node);
  }
  const [a, b] = nodes as [OrcaNode, OrcaNode];
  await b.join(a.endpoints[0]!);
  return [a, b];
}

function seenBy(observer: OrcaNode, subject: OrcaNode) {
  return observer.members().find((peer) => peer.orca_node_id === subject.orcaNodeId);
}

describe("self-description after join (G13)", () => {
  it("reaches a peer that already knows the node with its next heartbeat", async () => {
    const [a, b] = await pair();
    expect(seenBy(a, b)?.models).toBeUndefined();

    // The host catalog arrives after the node joined.
    b.setModelCatalog([{ provider: "p", model: "m", name: "M" }], { provider: "p", model: "m" }, "high");
    expect(seenBy(a, b)?.models).toBeUndefined();

    await b.heartbeat(a.endpoints[0]!);
    expect(seenBy(a, b)).toMatchObject({
      models: [{ provider: "p", model: "m", name: "M" }],
      default_model: { provider: "p", model: "m", reasoning_effort: "high" },
      default_reasoning_effort: "high",
    });

    // A catalog the node no longer advertises does not linger.
    b.setModelCatalog([], null, null);
    await b.heartbeat(a.endpoints[0]!);
    expect(seenBy(a, b)).toMatchObject({ default_model: null, default_reasoning_effort: null });
    expect(seenBy(a, b)?.models).toBeUndefined();
  }, 15_000);

  it("is replaced by a repeated join, in both directions", async () => {
    const [a, b] = await pair();
    a.setModelCatalog([{ provider: "pa", model: "ma" }], null);
    b.setModelCatalog([{ provider: "pb", model: "mb" }], null);

    await b.join(a.endpoints[0]!);
    // A records B's join body; B records the self record in A's answer.
    expect(seenBy(a, b)?.models).toEqual([{ provider: "pb", model: "mb" }]);
    expect(seenBy(b, a)?.models).toEqual([{ provider: "pa", model: "ma" }]);
  }, 15_000);
});
