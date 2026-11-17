/**
 * Build the DSH client bundle: `client/index.tsx` → `lib/client.js`.
 *
 * The shell loads a client bundle as a classic script that registers a lazy
 * factory with `window.__ModuleLoader__`; the factory's `require` resolves the
 * shell's platform module table only. So the source is bundled as CommonJS
 * with React left external and wrapped in that registration, the same shape
 * DSH's own client plugins ship. `lib/` is a build output and not committed.
 *
 * Usage: node scripts/build-client.ts [outfile]
 */

import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/** Module id the shell registers the factory under: the package name. */
const MODULE_ID = "orca-pod";

/** Platform modules the factory's `require` answers; everything else is bundled. */
export const CLIENT_EXTERNALS = ["react", "react/jsx-runtime"];

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export async function buildClient(outfile = `${ROOT}lib/client.js`): Promise<void> {
  await build({
    absWorkingDir: ROOT,
    entryPoints: ["client/index.tsx"],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: CLIENT_EXTERNALS,
    sourcemap: "linked",
    legalComments: "none",
    logLevel: "warning",
    banner: {
      js: `window.__ModuleLoader__.load({id:${JSON.stringify(MODULE_ID)},factory:require=>{var module={exports:{}};var exports=module.exports;`,
    },
    footer: { js: "return module.exports}});" },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildClient(process.argv[2]);
}
