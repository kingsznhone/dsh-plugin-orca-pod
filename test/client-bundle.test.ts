import { runInNewContext } from "node:vm";

import { build } from "rolldown";
import { beforeAll, describe, expect, it } from "vitest";

import config, { CLIENT_EXTERNALS, compileCssModule } from "../rolldown.config.ts";

let source: string;

beforeAll(async () => {
  // The real config, built in memory: the bundle is the one chunk.
  const { output } = await build({ ...config, write: false });
  source = output[0].code;
}, 60_000);

type Factory = (require: (id: string) => unknown) => { inject: string[]; apply: (ctx: unknown) => void };

type StyleTag = { dataset: { plugin?: string; pluginCss?: string }; textContent: string };

/** The slice of `document` the CSS modules touch: style tags in `<head>`, looked up by `data-plugin-css`. */
function fakeDocument() {
  const head: StyleTag[] = [];
  return {
    head: { appendChild: (tag: StyleTag) => head.push(tag), tags: head },
    createElement: (): StyleTag => ({ dataset: {}, textContent: "" }),
    querySelector: (selector: string) =>
      head.find((tag) => selector === `style[data-plugin-css=${JSON.stringify(tag.dataset.pluginCss)}]`) ?? null,
  };
}

/** Run the classic script against a fake shell and return the factory it registered. */
function registered(document?: ReturnType<typeof fakeDocument>): { id: string; factory: Factory } {
  const loads: Array<{ id: string; factory: Factory }> = [];
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (entry: { id: string; factory: Factory }) => loads.push(entry) } },
    ...(document === undefined ? {} : { document }),
  });
  expect(loads).toHaveLength(1);
  return loads[0]!;
}

describe("client bundle", () => {
  it("registers one lazy factory under the package name", () => {
    expect(registered().id).toBe("orca-pod");
  });

  it("requires only the shell's platform modules", () => {
    const requested = new Set<string>();
    const exports = registered().factory((id) => {
      requested.add(id);
      return {};
    });
    expect([...requested].sort()).toEqual([...CLIENT_EXTERNALS].sort());
    expect(exports.inject).toEqual(["slots", "locale"]);
  });

  it("registers its dictionaries and slots through the client services", () => {
    const { apply } = registered().factory(() => ({}));
    const dictionaries: string[] = [];
    const slots: string[] = [];
    apply({
      locale: {
        register: (ns: string, locale: string) => {
          dictionaries.push(`${ns}:${locale}`);
          return () => {};
        },
        bind: () => (key: string) => key,
        subscribe: () => () => {},
        getLocale: () => ({ active: "en" }),
      },
      slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: (slot: { id: string }) => {
          slots.push(slot.id);
          return () => {};
        },
      },
      effect: (execute: () => () => void) => execute(),
    });
    expect(dictionaries).toEqual(["orca-pod:en", "orca-pod:zh"]);
    expect(slots).toEqual([
      "orca-pod",
      "orca-pod",
      "orca-pod.panel",
      "orca-pod.approval-popup",
      "orca-pod.sounds",
      "orca-pod.approval-dock",
    ]);
  });

  it("injects one owned style tag per CSS module, with every class scoped to the plugin", () => {
    const document = fakeDocument();
    const { factory } = registered(document);
    factory(() => ({}));
    // A second materialization (the shell removes owned tags before a reload; here they stay) adds nothing.
    factory(() => ({}));
    const tags = document.head.tags;
    expect(tags.map((tag) => tag.dataset.pluginCss).sort()).toEqual([
      "orca-pod/approvals.module.css",
      "orca-pod/panel.module.css",
      "orca-pod/settings.module.css",
      "orca-pod/ui.module.css",
    ]);
    for (const tag of tags) {
      expect(tag.dataset.plugin).toBe("orca-pod");
      const file = tag.dataset.pluginCss?.replace(/^orca-pod\/|\.module\.css$/g, "");
      const classes = tag.textContent.match(/\.-?[A-Za-z_][\w-]*/g) ?? [];
      expect(classes.length).toBeGreaterThan(0);
      for (const name of classes) expect(name.startsWith(`.orca-pod-${file}_`), name).toBe(true);
    }
  });
});

describe("CSS modules", () => {
  it("scopes local names, keyframes and composes, and leaves :global and strings alone", () => {
    const { css, names } = compileCssModule(
      [
        ".row{color:red}",
        ".wide{composes:row;width:1px}",
        ':global(.dsw-host) .row[data-x=".foo"]{background:url(a.svg)}',
        "@keyframes spin{to{opacity:0}}",
        ".busy{animation:spin 1s}",
      ].join("\n"),
      "x",
    );
    expect(names).toEqual({
      row: "orca-pod-x_row",
      wide: "orca-pod-x_wide orca-pod-x_row",
      spin: "orca-pod-x_spin",
      busy: "orca-pod-x_busy",
    });
    expect(css).toContain(".dsw-host .orca-pod-x_row[data-x=");
    expect(css).toContain("url(a.svg)");
    expect(css).not.toMatch(/orca-pod-x_(foo|svg)/);
    expect(css).toContain("@keyframes orca-pod-x_spin");
  });
});
