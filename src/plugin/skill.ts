/**
 * Installable DSH skill that teaches any session on this machine how to drive
 * the `orca-node` CLI.
 *
 * The bundle itself only registers tools inside the DSH host process it runs
 * in. The ACP executor and CLI sessions start *other* `dsh` subprocesses (other
 * profiles), so the only portable way to hand them a capability is a skill
 * file under the user skill root (`$DSH_HOME/skills` or `~/.dsh/skills`). The
 * file is written during plugin apply, with the CLI path and data root of this
 * installation baked in; rewriting on version/path changes keeps it current.
 *
 * The body is versioned as plain Markdown in `skills/orca-node/SKILL.md` so it
 * can be reviewed and edited without touching TypeScript; `{{cli}}` marks the
 * per-install CLI invocation. DSH also discovers project roots
 * (`<projectRoot>/.dsh/skills`, rank 100) and the user root (rank 400, this
 * file). The user root is deliberate: task sessions run with the workgroup root
 * as their cwd, which usually has no `.git`, so a project-local copy would only
 * cover the repository checkout itself rather than every profile on the machine.
 */

import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Skill name; also the directory name under the user skill root. */
export const SKILL_NAME = "orca-node"

/** Canonical skill body shipped with the bundle; `{{cli}}` is rendered per install. */
export const SKILL_TEMPLATE_URL = new URL("../../skills/orca-node/SKILL.md", import.meta.url)

/** Token in the template that receives the absolute `orca-node` CLI invocation. */
export const CLI_PLACEHOLDER = "{{cli}}"

/** Inputs baked into the installed skill body. */
export interface SkillOptions {
  /** Absolute path of the orca-pod CLI entry (`src/cli.ts`). */
  cliPath: string
  /** Data root this installation reads its config and keys from. */
  dataRoot: string
}

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

/** Absolute path of the skill file for one DSH home. */
export function skillPath(dshHome: string): string {
  return join(dshHome, "skills", SKILL_NAME, "SKILL.md")
}

/**
 * Render the skill markdown (YAML frontmatter + body) from the shipped template.
 *
 * Frontmatter fields follow the DSH filesystem skill provider: `name` and
 * `description` are required, `whenToUse` is optional, and model invocation is
 * on unless `disable-model-invocation` is true.
 */
export function skillMarkdown(options: SkillOptions): string {
  const cli = `node "${options.cliPath}" --data-root "${options.dataRoot}"`
  const template = readFileSync(SKILL_TEMPLATE_URL, "utf8")
  if (!template.includes(CLI_PLACEHOLDER)) {
    throw new Error(`skill template ${SKILL_TEMPLATE_URL.pathname} does not contain ${CLI_PLACEHOLDER}`)
  }
  return template.replaceAll(CLI_PLACEHOLDER, cli)
}

/**
 * Install or refresh the skill under `dshHome`.
 *
 * @returns the target path and whether its content changed.
 */
export async function installSkill(
  options: SkillOptions,
  dshHome: string = resolveDshHome(),
): Promise<InstalledSkill> {
  const path = skillPath(dshHome)
  const next = skillMarkdown(options)
  const current = await readFile(path, "utf8").catch(() => undefined)
  if (current === next) return { path, written: false }
  await mkdir(join(dshHome, "skills", SKILL_NAME), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, next, "utf8")
  await rename(temporary, path)
  return { path, written: true }
}
