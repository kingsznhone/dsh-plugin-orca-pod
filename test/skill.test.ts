import { mkdtemp, readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  CLI_PLACEHOLDER,
  installSkill,
  resolveDshHome,
  SKILL_TEMPLATE_URL,
  skillMarkdown,
  skillPath,
} from "../src/plugin/skill.ts"

const OPTIONS = { cliPath: "/opt/orca-pod/src/cli.ts", dataRoot: "/tmp/orca-data" }

describe("orca-node skill", () => {
  it("keeps the editable template in the repository", () => {
    const template = readFileSync(SKILL_TEMPLATE_URL, "utf8")
    expect(template).toContain(CLI_PLACEHOLDER)
    expect(template).toContain("name: orca-node")
    expect(template).toContain("## Add a machine to the mesh")
  })

  it("renders frontmatter the filesystem skill provider accepts", () => {
    const markdown = skillMarkdown(OPTIONS)
    expect(markdown.startsWith("---\n")).toBe(true)
    const closing = markdown.indexOf("\n---\n", 4)
    expect(closing).toBeGreaterThan(0)
    const frontmatter = markdown.slice(4, closing)
    expect(frontmatter).toContain("name: orca-node")
    expect(frontmatter).toContain("description: ")
    expect(frontmatter).toContain("whenToUse: ")
    expect(frontmatter).toContain("escalate")
    expect(markdown).toContain('node "/opt/orca-pod/src/cli.ts" --data-root "/tmp/orca-data"')
    expect(markdown).toContain("exit codes")
    expect(markdown).not.toContain("{{")
  })

  it("installs once and rewrites only when the content changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "orca-skill-"))
    const first = await installSkill(OPTIONS, home)
    expect(first.written).toBe(true)
    expect(first.path).toBe(skillPath(home))
    expect(await readFile(first.path, "utf8")).toContain(OPTIONS.cliPath)

    const second = await installSkill(OPTIONS, home)
    expect(second.written).toBe(false)

    const moved = await installSkill({ ...OPTIONS, cliPath: "/other/cli.ts" }, home)
    expect(moved.written).toBe(true)
    expect(await readFile(moved.path, "utf8")).toContain("/other/cli.ts")
  })

  it("resolves DSH_HOME before the default home", () => {
    const custom = join(tmpdir(), "orca-dsh-home")
    expect(resolveDshHome({ DSH_HOME: custom })).toBe(resolve(custom))
    expect(resolveDshHome({ DSH_HOME: "  " })).toContain(".dsh")
    expect(resolveDshHome({})).toContain(".dsh")
  })
})
