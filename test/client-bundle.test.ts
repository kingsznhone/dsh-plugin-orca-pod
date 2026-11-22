import { runInNewContext } from "node:vm";

import { build } from "rolldown";
import { beforeAll, describe, expect, it } from "vitest";

import config, { CLIENT_EXTERNALS, compileCssModule } from "../rolldown.config.ts";
import { parseApiResponse } from "../src/client/http.ts";

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
    expect(registered().id).toBe("dsh-plugin-orca-pod");
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
    expect(dictionaries).toEqual(["dsh-plugin-orca-pod:en", "dsh-plugin-orca-pod:zh"]);
    expect(slots).toEqual([
      "dsh-plugin-orca-pod",
      "dsh-plugin-orca-pod",
      "dsh-plugin-orca-pod.panel",
      "dsh-plugin-orca-pod.approval-popup",
      "dsh-plugin-orca-pod.sounds",
      "dsh-plugin-orca-pod.approval-dock",
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
      "dsh-plugin-orca-pod/approvals.module.css",
      "dsh-plugin-orca-pod/panel.module.css",
      "dsh-plugin-orca-pod/settings.module.css",
      "dsh-plugin-orca-pod/ui.module.css",
    ]);
    for (const tag of tags) {
      expect(tag.dataset.plugin).toBe("dsh-plugin-orca-pod");
      const file = tag.dataset.pluginCss?.replace(/^dsh-plugin-orca-pod\/|\.module\.css$/g, "");
      const classes = tag.textContent.match(/\.-?[A-Za-z_][\w-]*/g) ?? [];
      expect(classes.length).toBeGreaterThan(0);
      for (const name of classes) expect(name.startsWith(`.dsh-plugin-orca-pod-${file}_`), name).toBe(true);
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
      row: "dsh-plugin-orca-pod-x_row",
      wide: "dsh-plugin-orca-pod-x_wide dsh-plugin-orca-pod-x_row",
      spin: "dsh-plugin-orca-pod-x_spin",
      busy: "dsh-plugin-orca-pod-x_busy",
    });
    expect(css).toContain(".dsw-host .dsh-plugin-orca-pod-x_row[data-x=");
    expect(css).toContain("url(a.svg)");
    expect(css).not.toMatch(/dsh-plugin-orca-pod-x_(foo|svg)/);
    expect(css).toContain("@keyframes dsh-plugin-orca-pod-x_spin");
  });
});

describe("parseApiResponse", () => {
  it("returns parsed JSON on 2xx and surfaces structured JSON error messages", async () => {
    const ok = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(await parseApiResponse(ok)).toEqual({ ok: true });

    const err = new Response(JSON.stringify({ error: "workgroup password required" }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" },
    });
    await expect(parseApiResponse(err)).rejects.toThrow("workgroup password required");

    const emptyJsonErr = new Response("{}", {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "application/json" },
    });
    await expect(parseApiResponse(emptyJsonErr)).rejects.toThrow("Request failed (HTTP 500 Internal Server Error)");
  });

  it("formats HTML proxy error pages without exposing raw markup or JSON parse errors", async () => {
    const htmlWithStatusText = new Response(
      "<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>",
      { status: 502, statusText: "Bad Gateway", headers: { "content-type": "text/html; charset=utf-8" } },
    );
    await expect(parseApiResponse(htmlWithStatusText)).rejects.toThrow("Request failed (HTTP 502 Bad Gateway)");

    const htmlHttp2 = new Response(
      "<html><head><title>502 Bad Gateway</title></head><body><h1>nginx</h1></body></html>",
      { status: 502, statusText: "", headers: { "content-type": "text/html" } },
    );
    await expect(parseApiResponse(htmlHttp2)).rejects.toThrow("Request failed (HTTP 502): Bad Gateway");

    const htmlNoTitle = new Response("<!doctype html><html><body>Gateway Timeout</body></html>", {
      status: 504,
      statusText: "",
      headers: { "content-type": "text/html" },
    });
    await expect(parseApiResponse(htmlNoTitle)).rejects.toThrow("Request failed (HTTP 504)");
  });

  it("summarizes plain-text errors, handles non-JSON 200 replies, and respects localized templates", async () => {
    const plain = new Response("upstream   temporarily\noverloaded", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/plain" },
    });
    await expect(parseApiResponse(plain)).rejects.toThrow(
      "Request failed (HTTP 503 Service Unavailable): upstream temporarily overloaded",
    );

    const longText = new Response("x".repeat(300), {
      status: 500,
      statusText: "",
      headers: { "content-type": "text/plain" },
    });
    await expect(parseApiResponse(longText)).rejects.toThrow(/^Request failed \(HTTP 500\): x{159}…$/);

    const html200 = new Response("<!doctype html><html><body>Login</body></html>", {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
    });
    const zh = {
      errHttpStatus: "请求失败（HTTP {status}）",
      errHttpStatusDetail: "请求失败（HTTP {status}）：{detail}",
      errInvalidResponse: "服务端返回了无法解析的响应（HTTP {status}）",
    };
    await expect(parseApiResponse(html200, (key) => zh[key])).rejects.toThrow(
      "服务端返回了无法解析的响应（HTTP 200 OK）",
    );
  });
});
