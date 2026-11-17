import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { CLI_PATH, siblingEntry } from "../src/entry.ts";

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
    expect(siblingEntry("cli", pathToFileURL(join(root, "src", "entry.ts")).href)).toBe(join(root, "src", "cli.ts"));
    expect(siblingEntry("cli", pathToFileURL(join(root, "lib", "entry.js")).href)).toBe(join(root, "lib", "cli.js"));
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
