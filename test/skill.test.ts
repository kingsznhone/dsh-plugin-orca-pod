import { mkdtemp, readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  installSkill,
  resolveDshHome,
  SKILL_SOURCE_DIR,
  SKILL_SOURCE_URL,
  skillBundle,
  skillPath,
} from "../src/plugin/skill.ts"

describe("orca-node skill bundle", () => {
  it("ships a standard bundle in .agents/skills", () => {
    const markdown = readFileSync(SKILL_SOURCE_URL, "utf8")
    expect(markdown.startsWith("---\n")).toBe(true)
    expect(markdown).toContain("name: orca-node")
    expect(markdown).toContain("description: ")
    expect(markdown).toContain("whenToUse: ")
    expect(markdown).not.toContain("{{")
    expect(basename(SKILL_SOURCE_DIR)).toBe("orca-node")
    expect(readFileSync(join(SKILL_SOURCE_DIR, "references", "add-machine.md"), "utf8")).toContain(
      "npx orca-pod install",
    )
  })

  it("reads SKILL.md plus references as the installable bundle", () => {
    const files = skillBundle()
    expect(files.map((file) => file.relative).sort()).toEqual([
      "SKILL.md",
      "references/add-machine.md",
    ])
    for (const file of files) expect(file.content.length).toBeGreaterThan(0)
  })

  it("installs the bundle under the DSH user home and is idempotent", async () => {
    const home = await mkdtemp(join(tmpdir(), "orca-skill-"))
    const first = await installSkill(home)
    expect(first.written).toBe(true)
    expect(first.path).toBe(skillPath(home))

    for (const file of skillBundle()) {
      const installed = join(dirname(first.path), file.relative)
      expect(await readFile(installed, "utf8")).toBe(file.content)
    }

    const second = await installSkill(home)
    expect(second.written).toBe(false)
  })

  it("resolves DSH_HOME before the default home", () => {
    const custom = join(tmpdir(), "orca-dsh-home")
    expect(resolveDshHome({ DSH_HOME: custom })).toBe(resolve(custom))
    expect(resolveDshHome({ DSH_HOME: "  " })).toContain(".dsh")
    expect(resolveDshHome({})).toContain(".dsh")
  })
})
