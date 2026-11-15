/**
 * Installable DSH skill that teaches any session on this machine how to drive
 * the `orca-node` CLI.
 *
 * The skill is a standard Agent Skill bundle in `skills/orca-node/`
 * (`SKILL.md` plus `references/`) that ships with the npm package. Local skill
 * roots such as `.agents/skills`, `.dsh/skills` and `$DSH_HOME/skills` are
 * install targets, not repository content (`.agents/` and `.dsh/` are
 * git-ignored here).
 *
 * The bundle itself only registers tools inside the DSH host process it runs
 * in. The ACP executor and CLI sessions start *other* `dsh` subprocesses (other
 * profiles), so the portable way to hand them a capability is a skill file
 * under the user skill root (`$DSH_HOME/skills` or `~/.dsh/skills`). That copy
 * is optional (`skill_injection`, off by default) and byte-identical to the
 * repository bundle; sessions spawned by the bundle also receive
 * `ORCA_POD_CLI`/`ORCA_POD_DATA_ROOT` in their environment, which the skill
 * prefers over the bare `orca-node` command.
 *
 * The user root (rank 400) is deliberate for the installed copy: task sessions
 * run with the workgroup root as their cwd, which usually has no `.git`, so a
 * project-local copy would only cover the repository checkout itself rather
 * than every profile on the machine.
 */

import { readdirSync, readFileSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Skill name; also the directory name under the user skill root. */
export const SKILL_NAME = "orca-node"

/** Canonical skill bundle shipped with the bundle (and this repository). */
export const SKILL_SOURCE_DIR = fileURLToPath(
  new URL("../../skills/orca-node/", import.meta.url),
)

/** Canonical `SKILL.md` entry of the bundle. */
export const SKILL_SOURCE_URL = new URL("../../skills/orca-node/SKILL.md", import.meta.url)

/** One installed skill file; `written` is false when the content was already current. */
export interface InstalledSkill {
  path: string
  written: boolean
}

/** Resolve the DSH user-data home: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["DSH_HOME"]?.trim()
  return resolve(configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".dsh"))
}

/** Absolute path of the skill entry for one DSH home. */
export function skillPath(dshHome: string): string {
  return join(dshHome, "skills", SKILL_NAME, "SKILL.md")
}

/** Read the shipped bundle: Markdown files keyed by their bundle-relative path. */
export function skillBundle(): { relative: string; content: string }[] {
  const files: { relative: string; content: string }[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const bundlePath = relative(SKILL_SOURCE_DIR, full).replaceAll("\\", "/")
      files.push({ relative: bundlePath, content: readFileSync(full, "utf8") })
    }
  }
  walk(SKILL_SOURCE_DIR)
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

/**
 * Install or refresh the skill under `dshHome`.
 *
 * @returns the target entry path and whether its content changed.
 */
export async function installSkill(dshHome: string = resolveDshHome()): Promise<InstalledSkill> {
  const path = skillPath(dshHome)
  const root = join(dshHome, "skills", SKILL_NAME)
  let written = false
  for (const file of skillBundle()) {
    const destination = join(root, file.relative)
    const current = await readFile(destination, "utf8").catch(() => undefined)
    if (current === file.content) continue
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.tmp-${process.pid}`
    await writeFile(temporary, file.content, "utf8")
    await rename(temporary, destination)
    written = true
  }
  return { path, written }
}
