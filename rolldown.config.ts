/**
 * The DSH client bundle: `src/client/index.tsx` → `lib/client.js`
 * (`npm run build` runs `rolldown -c`, `npm run watch:client` adds `--watch`).
 *
 * The shell loads a client bundle as a classic script that registers a lazy
 * factory with `window.__ModuleLoader__`; the factory's `require` resolves the
 * shell's platform module table only. So the source is bundled as CommonJS
 * with the platform modules left external and wrapped in that registration,
 * the same shape and toolchain (Rolldown, Lightning CSS) as DSH's own client
 * plugins. In watch mode DSH's `client-hmr` notices the rebuilt bundle and
 * reloads the plugin in the page.
 *
 * Styles are CSS modules (`src/client/*.module.css`), compiled the way DSH's own
 * plugins are: class names are scoped per file, and the sheet is injected as a
 * `<style data-plugin data-plugin-css>` when the module materializes, so the
 * shell's module system owns it and removes it when the plugin is disabled or
 * its bundle is rebuilt.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { transform as compileCss } from "lightningcss";
import type { Plugin, RolldownOptions } from "rolldown";

/** Module id the shell registers the factory under: the package name. */
const MODULE_ID = "dsh-plugin-orca-pod";

/** Platform modules the factory's `require` answers; everything else is bundled. */
export const CLIENT_EXTERNALS = ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"];

/** Lowest Chromium the shell runs on, for the CSS output (Lightning CSS encodes it as `major << 16`). */
const CHROME = 120;

/** Compile one CSS module: `{ css, names }` with every local name renamed to `<module>-<file>_<name>`. */
export function compileCssModule(source: string, file: string): { css: string; names: Record<string, string> } {
  const { code, exports } = compileCss({
    // `[name]` in the pattern is the file name without its extension.
    filename: `${file}.css`,
    code: Buffer.from(source),
    cssModules: { pattern: `${MODULE_ID}-[name]_[local]` },
    minify: true,
    targets: { chrome: CHROME << 16 },
  });
  const names: Record<string, string> = {};
  for (const [local, entry] of Object.entries(exports ?? {})) {
    const composed = entry.composes.map((reference) => {
      if (reference.type === "dependency") {
        throw new Error(`${file}.module.css: composes from another file (${reference.specifier}) is not supported`);
      }
      return reference.name;
    });
    names[local] = [entry.name, ...composed].join(" ");
  }
  return { css: new TextDecoder().decode(code), names };
}

/** `import styles from "./x.module.css"`: the scoped class map, with the sheet injected once per page. */
function cssModules(): Plugin {
  return {
    name: "dsh-plugin-orca-pod-css-modules",
    load: {
      filter: { id: /\.module\.css$/ },
      async handler(path) {
        // Rolldown watches only what it reads itself; a file a plugin loads has to be registered.
        this.addWatchFile(path);
        const file = basename(path, ".module.css");
        const { css, names } = compileCssModule(await readFile(path, "utf8"), file);
        const tagId = `${MODULE_ID}/${file}.module.css`;
        const selector = `style[data-plugin-css=${JSON.stringify(tagId)}]`;
        const code = [
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
        return { code, moduleType: "js" };
      },
    },
  };
}

// `satisfies` rather than `defineConfig`, which widens `output` to a maybe-array the tests would have to narrow.
export default {
  input: "src/client/index.tsx",
  platform: "browser",
  tsconfig: "src/client/tsconfig.json",
  transform: { target: "es2022", jsx: { runtime: "automatic" } },
  external: CLIENT_EXTERNALS,
  // The approval cues are inlined so the bundle needs no asset route.
  moduleTypes: { ".mp3": "dataurl" },
  plugins: [cssModules()],
  logLevel: "warn",
  output: {
    file: "lib/client.js",
    format: "cjs",
    codeSplitting: false,
    sourcemap: true,
    comments: { legal: false },
    banner: `window.__ModuleLoader__.load({id:${JSON.stringify(MODULE_ID)},factory:require=>{var module={exports:{}};var exports=module.exports;`,
    footer: "return module.exports}});",
  },
} satisfies RolldownOptions;
