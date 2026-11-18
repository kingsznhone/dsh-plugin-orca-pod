import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { nodeParts } from "./support/node.ts";
import { Orca } from "../src/node/orca.ts";
import { wg } from "./fixtures/ids.ts";
import { peersOf } from "./support/node.ts";

const LIVE: Orca[] = [];

afterEach(async () => {
  for (const node of LIVE.splice(0)) await node.stop();
});

async function pair(): Promise<[Orca, Orca]> {
  const workgroupId = wg(`wg-${randomBytes(6).toString("hex")}`);
  const nodes = await Promise.all(
    [0, 1].map(
      async () =>
        new Orca(
          ...nodeParts({
            workgroup_id: workgroupId,
            workgroup_password: "same password",
            data_root: mkdtempSync(join(tmpdir(), "orca-self-")),
            port: 0,
          }),
        ),
    ),
  );
  for (const node of nodes) {
    await node.start();
    LIVE.push(node);
  }
  const [a, b] = nodes as [Orca, Orca];
  await b.mesh.probe(a.mesh.self.endpoints[0]!);
  return [a, b];
}

function seenBy(observer: Orca, subject: Orca) {
  return peersOf(observer).find((peer) => peer.orca_node_id === subject.orcaNodeId);
}

describe("self-description after join (G13)", () => {
  it("reaches a peer that already knows the node with its next heartbeat", async () => {
    const [a, b] = await pair();
    expect(seenBy(a, b)?.models).toBeUndefined();

    // The host catalog arrives after the node joined.
    b.models.update([{ provider: "p", id: "m", name: "M" }], { provider: "p", model: "m" }, ReasoningEffortId("high"));
    expect(seenBy(a, b)?.models).toBeUndefined();

    await b.mesh.probe(a.mesh.self.endpoints[0]!);
    expect(seenBy(a, b)).toMatchObject({
      models: [{ provider: "p", id: "m", name: "M" }],
      default_model: { provider: "p", model: "m", reasoningEffort: "high" },
      default_reasoning_effort: "high",
    });

    // A catalog the node no longer advertises does not linger.
    b.models.update([], null, null);
    await b.mesh.probe(a.mesh.self.endpoints[0]!);
    expect(seenBy(a, b)).toMatchObject({ default_model: null, default_reasoning_effort: null });
    expect(seenBy(a, b)?.models).toBeUndefined();
  }, 15_000);

  it("is replaced by a repeated join, in both directions", async () => {
    const [a, b] = await pair();
    a.models.update([{ provider: "pa", id: "ma", name: "MA" }], null);
    b.models.update([{ provider: "pb", id: "mb", name: "MB" }], null);

    await b.mesh.probe(a.mesh.self.endpoints[0]!);
    // A records B's join body; B records the self record in A's answer.
    expect(seenBy(a, b)?.models).toEqual([{ provider: "pb", id: "mb", name: "MB" }]);
    expect(seenBy(b, a)?.models).toEqual([{ provider: "pa", id: "ma", name: "MA" }]);
  }, 15_000);
});
