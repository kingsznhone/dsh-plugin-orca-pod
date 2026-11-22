/**
 * The node's settings, kept in `<data_root>/settings.json` (implementation.md 2): one file for
 * the whole machine, shared by every DSH profile. They cannot live in a profile's
 * plugin config, which the config editor writes per profile. The file holds no
 * secret: the password is a DSH credential and never reaches it.
 */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

import { errorMessage, isMissingFile } from "../core/errors.ts";
import { isRecord } from "../core/schema.ts";

export class SettingsFile {
  readonly path: string;

  constructor(dataRoot: string) {
    this.path = join(dataRoot, "settings.json");
  }

  /**
   * The stored settings as the file holds them, not yet canonical: that is
   * `parseSettings`' job, and keys this version does not know are kept so a write
   * never drops them. None yet is `{}`; an unreadable file is an error that names
   * it (never silently reset).
   */
  async read(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw new Error(`cannot read ${this.path}: ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${this.path} is not valid JSON: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed)) throw new Error(`${this.path} must hold a JSON object`);
    return parsed;
  }

  async write(settings: Record<string, unknown>): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
