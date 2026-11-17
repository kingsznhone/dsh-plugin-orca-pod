/**
 * Paths of the package's own executable entries.
 *
 * A source checkout runs the `.ts` modules directly (Node type stripping,
 * vitest); the published package runs the compiled `.js` under `lib/`. The compiler's
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
