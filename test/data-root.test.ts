import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataRoot } from "../src/plugin/data-root.ts";

describe("defaultDataRoot", () => {
  it("is orca-pod under the DSH home the host resolved", () => {
    expect(defaultDataRoot("C:/tmp/home", {})).toBe(join(resolve("C:/tmp/home"), "orca-pod"));
  });

  it("falls back to DSH_HOME, then the user home", () => {
    expect(defaultDataRoot(undefined, { DSH_HOME: "C:/tmp/home" })).toBe(join(resolve("C:/tmp/home"), "orca-pod"));
    expect(defaultDataRoot(undefined, {})).toBe(join(homedir(), ".dsh", "orca-pod"));
  });

  it("is the same for every profile: nothing about a profile or an explicit override moves it", () => {
    const env = {
      DSH_HOME: "C:/tmp/home",
      DSH_PROFILE_DIR: "C:/tmp/home/profiles/desktop",
      ORCA_POD_HOME: "C:/elsewhere",
    };
    expect(defaultDataRoot(undefined, env)).toBe(join(resolve("C:/tmp/home"), "orca-pod"));
  });
});
