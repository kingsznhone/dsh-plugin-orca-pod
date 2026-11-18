/**
 * Paths of the package's own executable entries.
 *
 * vitest and tsx load the `.ts` modules of `src/`; the published package runs the
 * compiled `.js` under `lib/`. The compiler's
 * `rewriteRelativeImportExtensions` only rewrites import specifiers, never URL
 * strings, so an entry is resolved with the extension of the module asking for
 * it. A hard-coded `../cli/main.ts` would point at a file that does not exist
 * in `lib/`.
 */

import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the entry `name` (relative, no extension) from the module at `moduleUrl`, with that module's extension. */
export function siblingEntry(name: string, moduleUrl: string): string {
  const extension = extname(fileURLToPath(moduleUrl)) === ".ts" ? ".ts" : ".js";
  return fileURLToPath(new URL(`./${name}${extension}`, moduleUrl));
}

/**
 * Absolute path of the `orca-node` CLI entry (`src/cli/main.ts` or `lib/cli/main.js`):
 * exported to executor sessions as `ORCA_POD_CLI` and used as the systemd
 * `ExecStart` target.
 */
export const CLI_PATH = siblingEntry("../cli/main", import.meta.url);

/**
 * Environment variable the task executor sets to "1" in every session it
 * spawns. An agent running a task must not start another one: tasks are
 * single-hop (§7.9), so the CLI's `send` and the plugin's `send` refuse while
 * it is set. This keeps a well-behaved agent from cascading; it is not a
 * security boundary, since the agent runs as the same OS user as the node.
 */
export const IN_TASK_ENV = "ORCA_POD_IN_TASK";

/** True inside a session the task executor spawned (see `IN_TASK_ENV`). */
export function runningInTask(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[IN_TASK_ENV] === "1";
}
