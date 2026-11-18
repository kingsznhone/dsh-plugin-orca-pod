/**
 * The peers joined at runtime (panel or `connect`), remembered in
 * `<data_root>/peers.json` so they are rejoined on the next start. This is state,
 * not settings: remembering a peer must not restart the plugin (§7.3, §9.2).
 */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "@deepseek-ai/cordis";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

import { errorMessage, isMissingFile } from "../core/errors.ts";
import { normalizePeerUrl } from "../core/net.ts";
import { isRecord } from "../core/schema.ts";

export class RememberedPeers {
  private peers: string[] = [];

  constructor(
    private readonly dataRoot: string,
    private readonly logger: Logger,
  ) {}

  /** The peers remembered so far, in the order they were added. */
  list(): readonly string[] {
    return this.peers;
  }

  /** Where the peers are kept, next to the persisted orca node config. */
  private get path(): string {
    return join(this.dataRoot, "peers.json");
  }

  /** Read the file; a missing or unreadable one means no peers. */
  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const peers = isRecord(parsed) && Array.isArray(parsed.peers) ? parsed.peers : [];
      this.peers = peers.filter((peer): peer is string => typeof peer === "string").map(normalizePeerUrl);
    } catch (error) {
      if (!isMissingFile(error)) this.logger.warn(`orca-pod: ignoring unreadable peer state: ${errorMessage(error)}`);
      this.peers = [];
    }
  }

  /** Remember one peer; one that is already remembered is not written again. */
  async add(peer: string): Promise<void> {
    if (this.peers.includes(peer)) return;
    this.peers = [...this.peers, peer];
    await this.save();
  }

  /** Forget every peer. */
  async clear(): Promise<void> {
    this.peers = [];
    await this.save();
  }

  /** Forget every peer and delete the file (the node is being reset). */
  async remove(): Promise<void> {
    this.peers = [];
    await rm(this.path, { force: true });
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify({ peers: this.peers }, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    });
  }
}
