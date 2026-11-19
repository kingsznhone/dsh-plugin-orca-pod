/**
 * Build the DSH client bundle: `src/client/index.tsx` → `lib/client.js`.
 *
 * The shell loads a client bundle as a classic script that registers a lazy
 * factory with `window.__ModuleLoader__`; the factory's `require` resolves the
 * shell's platform module table only. So the source is bundled as CommonJS
 * with the platform modules left external and wrapped in that registration,
 * the same shape DSH's own client plugins ship. `lib/` is a build output and
 * not committed.
 *
 * Styles are CSS modules (`src/client/*.module.css`), compiled the way DSH's own
 * plugins are: class names are scoped per file, and the sheet is injected as a
 * `<style data-plugin data-plugin-css>` when the module materializes, so the
 * shell's module system owns it and removes it when the plugin is disabled.
 *
 * Usage: node scripts/build-client.ts [outfile]
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin, transform } from "esbuild";

/** Module id the shell registers the factory under: the package name. */
const MODULE_ID = "orca-pod";

/** Platform modules the factory's `require` answers; everything else is bundled. */
export const CLIENT_EXTERNALS = ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"];

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A class selector: `.name` where the name does not start with a digit (so `.5px` is left alone). */
const CLASS_SELECTOR = /\.(-?[A-Za-z_][\w-]*)/g;

/** Scope one CSS module: `{ css, names }` with every class renamed to `<module>-<file>_<class>`. */
export async function scopeCssModule(
  source: string,
  file: string,
): Promise<{ css: string; names: Record<string, string> }> {
  const prefix = `${MODULE_ID}-${file}_`;
  const names: Record<string, string> = {};
  const scoped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(CLASS_SELECTOR, (_match, name: string) => {
    names[name] = prefix + name;
    return `.${prefix}${name}`;
  });
  const { code } = await transform(scoped, { loader: "css", minify: true, target: "chrome120" });
  return { css: code.trim(), names };
}

/** `import styles from "./x.module.css"`: the scoped class map, with the sheet injected once per page. */
function cssModules(): Plugin {
  return {
    name: "orca-pod-css-modules",
    setup(context) {
      context.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
        const file = basename(path, ".module.css");
        const { css, names } = await scopeCssModule(await readFile(path, "utf8"), file);
        const tagId = `${MODULE_ID}/${file}.module.css`;
        const selector = `style[data-plugin-css=${JSON.stringify(tagId)}]`;
        const contents = [
          `const css = ${JSON.stringify(css)};`,
          `if (typeof document !== "undefined" && document.querySelector(${JSON.stringify(selector)}) === null) {`,
          `  const tag = document.createElement("style");`,
          `  tag.dataset.plugin = ${JSON.stringify(MODULE_ID)};`,
          `  tag.dataset.pluginCss = ${JSON.stringify(tagId)};`,
          "  tag.textContent = css;",
          "  document.head.appendChild(tag);",
          "}",
          `export default ${JSON.stringify(names)};`,
        ].join("\n");
        return { contents, loader: "js", watchFiles: [path] };
      });
    },
  };
}

export async function buildClient(outfile = `${ROOT}lib/client.js`): Promise<void> {
  await build({
    absWorkingDir: ROOT,
    entryPoints: ["src/client/index.tsx"],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: CLIENT_EXTERNALS,
    // The approval cues are inlined so the bundle needs no asset route.
    loader: { ".mp3": "dataurl" },
    plugins: [cssModules()],
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
