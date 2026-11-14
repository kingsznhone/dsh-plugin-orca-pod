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
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Skill name; also the directory name under the user skill root. */
export const SKILL_NAME = "orca-node"

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
 * Render the skill markdown (YAML frontmatter + body).
 *
 * Frontmatter fields follow the DSH filesystem skill provider: `name` and
 * `description` are required, `whenToUse` is optional, and model invocation is
 * on unless `disable-model-invocation` is true.
 */
export function skillMarkdown(options: SkillOptions): string {
  const cli = `node "${options.cliPath}" --data-root "${options.dataRoot}"`
  return `---
name: ${SKILL_NAME}
description: Delegate work to other orca nodes in this mesh, check tasks you already dispatched, and escalate a blocked sub-task to its origin.
whenToUse: When the user asks you to run something on another machine or orca node, when you need the status or result of a task you dispatched earlier, or when waiting on a sub-task returns exit code 3.
---

# Orca node CLI

This machine runs an orca node. \`orca-node\` talks to it over loopback, signs
as this orca node, and does **not** listen on a port or start a second process.
Use it whenever a task has to leave this machine.

\`\`\`bash
${cli} members --json                     # known peers: id, endpoints, state
${cli} send --peer <host:port> --text -   # dispatch a task; text from stdin
#   add --model <provider/model> to pick a model the target advertises (§6.16)
${cli} wait --peer <host:port> --task <id> --local-task <this task> --timeout 120 --json
${cli} status --peer <host:port> --task <id> --json
${cli} escalate --peer <child:port> --task <child task> --local-task <this task> --json
\`\`\`

\`wait\` exit codes: \`0\` completed, \`1\` failed or canceled, \`2\` still
running, \`3\` the target is waiting for a human decision.

## Rules

- Each peer in \`members\` carries an ordered \`endpoints\` list (primary first); pass any one to other commands. A bare \`host:port\` is accepted.
- Pass \`--local-task <this task>\` to \`wait\` so a child permission request is
  escalated to your origin automatically; \`wait\` keeps going after the decision.
- **Never approve your own escalation.** If \`wait\` exits \`3\`, run
  \`escalate\` and tell the user what is blocked and why.
- Pass \`--text -\` so the task text travels on stdin (no shell quoting).
- Use \`--json\` whenever you need exact ids, states, or artifacts.
- A task you dispatch is single-hop: this orca node does not forward it.
`
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
