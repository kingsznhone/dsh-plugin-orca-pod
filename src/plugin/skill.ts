/**
 * DSH skill bundled with the package.
 *
 * The skill teaches any session on this machine how to drive the `orca-node`
 * CLI. It is a standard Agent Skill bundle in `skills/orca-node/` (`SKILL.md`
 * plus `references/`) that ships with the npm package and is registered in
 * memory through `ctx.skills.register`; the host-level registry makes it
 * visible to every session this host runs. Nothing is copied into a user skill
 * root, so there is no second copy to keep in sync.
 *
 * The bundle itself only registers tools inside the DSH host process it runs
 * in. The ACP executor and CLI sessions start *other* `dsh` subprocesses (other
 * profiles), which is why the skill exists; sessions spawned by the bundle also
 * receive `ORCA_POD_CLI`/`ORCA_POD_DATA_ROOT` in their environment, which the
 * skill prefers over the bare `orca-node` command.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillRegistration } from "./dsh.ts";

/** Skill name; also its frontmatter name. */
const SKILL_NAME = "orca-node";

/** Canonical skill bundle shipped with the bundle (and this repository). */
export const SKILL_SOURCE_DIR = fileURLToPath(new URL("../../skills/orca-node/", import.meta.url));

/** Canonical `SKILL.md` entry of the bundle. */
export const SKILL_ENTRY = join(SKILL_SOURCE_DIR, "SKILL.md");

/** Flat skill frontmatter plus the Markdown body that follows it. */
interface SkillDocument {
  name: string;
  description: string;
  whenToUse: string | undefined;
  body: string;
}

/**
 * Split a skill file into its frontmatter and body.
 *
 * Agent Skill frontmatter is a flat `key: value` block between `---` fences, so
 * this reads exactly that subset instead of adding a YAML dependency.
 */
export function parseSkillDocument(source: string): SkillDocument {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md must start with a frontmatter fence");
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) throw new Error("SKILL.md frontmatter is not closed");
  const fields = new Map<string, string>();
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) fields.set(key, value);
  }
  const name = fields.get("name") ?? SKILL_NAME;
  const description = fields.get("description");
  if (description === undefined) throw new Error("SKILL.md frontmatter needs a description");
  const bodyStart = normalized.indexOf("\n", end + 1);
  return {
    name,
    description,
    whenToUse: fields.get("whenToUse"),
    body: (bodyStart === -1 ? "" : normalized.slice(bodyStart + 1)).trim(),
  };
}

/**
 * Build the registration the host's skill registry accepts. The bundle is read
 * from disk on first use; `resourceBase` points relative references at the
 * shipped `references/` directory.
 */
export function skillRegistration(): SkillRegistration {
  const document = parseSkillDocument(readFileSync(SKILL_ENTRY, "utf8"));
  return {
    name: document.name,
    description: document.description,
    whenToUse: document.whenToUse,
    content: document.body,
    source: "runtime",
    path: SKILL_ENTRY,
    resourceBase: { kind: "directory", path: SKILL_SOURCE_DIR },
  };
}
