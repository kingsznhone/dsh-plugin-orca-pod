import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildClient, CLIENT_EXTERNALS } from "../scripts/build-client.ts";

let dir: string;
let source: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-client-"));
  await buildClient(join(dir, "client.js"));
  source = await readFile(join(dir, "client.js"), "utf8");
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Factory = (require: (id: string) => unknown) => { inject: string[]; apply: (ctx: unknown) => void };

/** Run the classic script against a fake shell and return the factory it registered. */
function registered(): { id: string; factory: Factory } {
  const loads: Array<{ id: string; factory: Factory }> = [];
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (entry: { id: string; factory: Factory }) => loads.push(entry) } },
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
});
