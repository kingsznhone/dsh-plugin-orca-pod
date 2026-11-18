import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { CLI_PATH, siblingEntry } from "../src/core/entry.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("package entries", () => {
  it("resolves a sibling entry with the extension of the asking module", () => {
    const root = join(fileURLToPath(new URL("../", import.meta.url)), "pkg");
    const from = (dir: string, file: string): string => pathToFileURL(join(root, dir, "kernel", file)).href;
    expect(siblingEntry("../cli/main", from("src", "entry.ts"))).toBe(join(root, "src", "cli", "main.ts"));
    expect(siblingEntry("../cli/main", from("lib", "entry.js"))).toBe(join(root, "lib", "cli", "main.js"));
  });

  it("points the CLI path at an existing file", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("does not hard-code a .ts sibling path that the build would leave dangling", () => {
    const offenders = sourceFiles(SRC).filter((path) =>
      /new URL\(\s*["'`][^"'`]*\.ts["'`]\s*,\s*import\.meta\.url/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
