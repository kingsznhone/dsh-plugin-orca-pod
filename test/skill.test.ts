import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { skillRegistration } from "../src/plugin/skill.ts";

describe("orca-node skill bundle", () => {
  it("registers the shipped bundle as a runtime skill, with its reference directory", () => {
    const registration = skillRegistration();
    const path = registration.path as string;
    expect(registration.name).toBe("orca-node");
    expect(registration.source).toBe("runtime");
    expect(basename(path)).toBe("SKILL.md");
    expect(basename(dirname(path))).toBe("orca-node");
    expect(registration.resourceBase?.kind).toBe("directory");
    expect(resolve((registration.resourceBase as { path: string }).path)).toBe(dirname(path));
    expect(readFileSync(join(dirname(path), "references", "add-machine.md"), "utf8")).toContain(
      "install this plugin in\n   all three profiles",
    );
  });

  it("reads the frontmatter and strips it from the body", () => {
    const registration = skillRegistration();
    const path = registration.path as string;
    expect(readFileSync(path, "utf8")).toContain("name: orca-node");
    expect(registration.description.length).toBeGreaterThan(0);
    expect(registration.whenToUse).toBeDefined();
    expect(registration.content.startsWith("#")).toBe(true);
    expect(registration.content).not.toContain("name: orca-node");
    expect(registration.content).not.toContain("whenToUse:");
  });
});
