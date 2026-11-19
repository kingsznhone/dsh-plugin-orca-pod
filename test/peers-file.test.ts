import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RememberedPeers } from "../src/plugin/peers-file.ts";
import { logger } from "./fixtures/pod.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orca-peers-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("RememberedPeers", () => {
  it("keeps what was added across instances, without duplicates", async () => {
    const root = await tempRoot();
    const first = new RememberedPeers(root, logger);
    await first.load();
    expect(first.list()).toEqual([]);

    await first.add("http://10.0.0.2:11811");
    await first.add("http://10.0.0.2:11811");
    await first.add("http://10.0.0.3:11811");
    expect(first.list()).toEqual(["http://10.0.0.2:11811", "http://10.0.0.3:11811"]);

    const second = new RememberedPeers(root, logger);
    await second.load();
    expect(second.list()).toEqual(first.list());
  });

  it("forgets every peer on reset, in memory and on disk", async () => {
    const root = await tempRoot();
    const peers = new RememberedPeers(root, logger);
    await peers.add("http://10.0.0.2:11811");
    await peers.remove();
    expect(peers.list()).toEqual([]);

    const reloaded = new RememberedPeers(root, logger);
    await reloaded.load();
    expect(reloaded.list()).toEqual([]);
  });

  it("normalizes what it reads and treats an unreadable file as no peers", async () => {
    const root = await tempRoot();
    const peers = new RememberedPeers(root, logger);
    await writeFile(
      join(root, "peers.json"),
      JSON.stringify({ peers: ["10.0.0.2", 7, "http://desk.example.com/"] }),
      "utf8",
    );
    await peers.load();
    expect(peers.list()).toEqual(["http://10.0.0.2:11811", "http://desk.example.com:80"]);

    await writeFile(join(root, "peers.json"), "{ not json", "utf8");
    await peers.load();
    expect(peers.list()).toEqual([]);
  });
});
