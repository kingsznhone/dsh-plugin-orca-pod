/**
 * Paths of the package's own executable entries.
 *
 * A source checkout runs the `.ts` modules directly (Node type stripping,
 * vitest); the published package runs the compiled `lib/*.js`. The compiler's
 * `rewriteRelativeImportExtensions` only rewrites import specifiers, never URL
 * strings, so a sibling entry is resolved with the extension of the module
 * asking for it. A hard-coded `./cli.ts` would point at a file that does not
 * exist in `lib/`.
 */

import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the entry `name` next to the module at `moduleUrl`, with that module's extension. */
export function siblingEntry(name: string, moduleUrl: string): string {
  const extension = extname(fileURLToPath(moduleUrl)) === ".ts" ? ".ts" : ".js";
  return fileURLToPath(new URL(`./${name}${extension}`, moduleUrl));
}

/**
 * Absolute path of the `orca-node` CLI entry (`src/cli.ts` or `lib/cli.js`):
 * exported to executor sessions as `ORCA_POD_CLI` and used as the systemd
 * `ExecStart` target.
 */
export const CLI_PATH = siblingEntry("cli", import.meta.url);
