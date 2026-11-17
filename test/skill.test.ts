import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSkillDocument, SKILL_ENTRY, SKILL_SOURCE_DIR, skillRegistration } from "../src/plugin/skill.ts";

describe("orca-node skill bundle", () => {
  it("ships a standard skill bundle under skills/", () => {
    const markdown = readFileSync(SKILL_ENTRY, "utf8");
    expect(markdown.startsWith("---\n")).toBe(true);
    expect(markdown).toContain("name: orca-node");
    expect(basename(SKILL_SOURCE_DIR)).toBe("orca-node");
    expect(readFileSync(join(SKILL_SOURCE_DIR, "references", "add-machine.md"), "utf8")).toContain(
      "npx orca-pod install",
    );
  });

  it("parses frontmatter and strips it from the body", () => {
    const document = parseSkillDocument(readFileSync(SKILL_ENTRY, "utf8"));
    expect(document.name).toBe("orca-node");
    expect(document.description.length).toBeGreaterThan(0);
    expect(document.whenToUse).toBeDefined();
    expect(document.content.startsWith("#")).toBe(true);
    expect(document.content).not.toContain("name: orca-node");
  });

  it("registers the bundle as a runtime skill with its reference directory", () => {
    const registration = skillRegistration();
    expect(registration.name).toBe("orca-node");
    expect(registration.source).toBe("runtime");
    expect(registration.path).toBe(SKILL_ENTRY);
    expect(registration.resourceBase).toEqual({ kind: "directory", path: SKILL_SOURCE_DIR });
    expect(registration.content).not.toContain("whenToUse:");
  });

  it("rejects a document without frontmatter or a description", () => {
    expect(() => parseSkillDocument("no frontmatter")).toThrow(/frontmatter fence/);
    expect(() => parseSkillDocument("---\nname: x\n---\nbody")).toThrow(/description/);
    // DSH's skill-name grammar (`isSkillName`) applies to the bundled file too.
    expect(() => parseSkillDocument("---\nname: Not A Name\ndescription: d\n---\nbody")).toThrow(/skill name/);
  });
});
