import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultDataRoot } from "../src/node/config.ts";

const profile = resolve(homedir(), ".dsh", "profiles", "desktop");

describe("defaultDataRoot", () => {
  it("prefers an explicit ORCA_POD_HOME", () => {
    expect(defaultDataRoot({ ORCA_POD_HOME: "C:/tmp/pod", DSH_HOME: "C:/tmp/home" })).toBe(resolve("C:/tmp/pod"));
  });

  it("uses DSH_PROFILE_DIR when the host exports it", () => {
    expect(defaultDataRoot({ DSH_PROFILE_DIR: profile, DSH_HOME: "C:/tmp/home" })).toBe(join(profile, "orca-pod"));
  });

  it("falls back to the loader baseUrl, which names the profile directory", () => {
    expect(defaultDataRoot({ DSH_HOME: "C:/tmp/home" }, pathToFileURL(profile).href)).toBe(join(profile, "orca-pod"));
    expect(defaultDataRoot({ DSH_HOME: "C:/tmp/home" }, profile)).toBe(join(profile, "orca-pod"));
  });

  it("ignores a baseUrl that does not name a profile directory", () => {
    expect(defaultDataRoot({ DSH_HOME: "C:/tmp/home" }, "file:///C:/tmp/app.asar/dsh")).toBe(
      join(resolve("C:/tmp/home"), "orca-pod"),
    );
  });

  it("falls back to the DSH home, then the user home", () => {
    expect(defaultDataRoot({ DSH_HOME: "C:/tmp/home" })).toBe(join(resolve("C:/tmp/home"), "orca-pod"));
    expect(defaultDataRoot({})).toBe(join(homedir(), ".dsh", "orca-pod"));
  });
});
