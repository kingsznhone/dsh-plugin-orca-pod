/** The `orca_pod` tool's file handling (§3.8): `send` with `files`, and `fetch`. */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

import { blobRefText } from "../src/core/blobs.ts";
import type { Orca } from "../src/node/orca.ts";
import { PodTool } from "../src/plugin/tools.ts";
import type { OptionalService } from "../src/plugin/services.ts";
import type { Tracker } from "../src/plugin/tracker.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { podRunning } from "./fixtures/pod.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OWN = fakeNodeId("own");
const PEER = fakeNodeId("peer");
const PEER_URL = "http://127.0.0.1:11811";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-tool-files-"));
  roots.push(root);
  return root;
}

const agent = { id: "session-1", status: "running" as const, session: {}, inject: () => {}, followup: () => {} };

/** A sandbox policy that resolves every session to one mode and workspace. */
const policyOf = (mode: string, workspaceRoot: string) =>
  ({ resolve: () => ({ mode, workspaceRoot }) }) as unknown as SandboxPolicyService;

/** The tool of a pod running `node`; `policy` is the host's sandbox policy, when it has one. */
function toolOf(node: unknown, policy?: SandboxPolicyService) {
  const sandbox =
    policy === undefined ? undefined : ({ current: () => policy } as unknown as OptionalService<"sandboxPolicy">);
  const tracker = { track: () => true } as unknown as Tracker;
  const { execute } = new PodTool(podRunning(node), tracker, sandbox).definition();
  return (args: Record<string, unknown>) =>
    execute(args, { signal: new AbortController().signal, agent } as unknown as ToolRunContext);
}

type Sent = { metadata?: { pod?: Record<string, unknown> } };

/** A node that records what `send` hands to the delegation and what the tool publishes. */
function sendingNode(publish: (path: string) => Promise<unknown>) {
  const sent: Sent[] = [];
  const node = {
    orcaNodeId: OWN,
    publish,
    mesh: {
      // Whatever the call names is the one node the task goes to.
      resolve: () => ({
        id: PEER,
        displayName: "peer",
        sendTask: async (input: Sent) => {
          sent.push(input);
          return { id: "task-1", status: { state: "submitted" } };
        },
        cancelTask: async () => ({}),
      }),
    },
  } as unknown as Orca;
  return { node, sent };
}

describe("orca_pod send with files", () => {
  it("publishes a local path first, then names it in metadata.pod.files next to a file a member published", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "plan.md"), "the plan");
    const published: string[] = [];
    const { node, sent } = sendingNode(async (path) => {
      published.push(path);
      return { blob_id: sha256("the plan"), path, size: 8, expires_at: null };
    });
    const theirs = blobRefText({ node: PEER, blob: sha256("theirs") });

    await toolOf(
      node,
      policyOf("workspace-write", root),
    )({ method: "send", peer: PEER_URL, text: "review", files: ["plan.md", theirs] });

    expect(published).toEqual([join(root, "plan.md")]);
    expect(sent[0]?.metadata?.pod?.files).toEqual([
      { ref: blobRefText({ node: OWN, blob: sha256("the plan") }), name: "plan.md" },
      { ref: theirs, name: sha256("theirs") },
    ]);
  });

  it("sends no files block when none are given, and names the path it could not publish", async () => {
    const { node, sent } = sendingNode(async () => {
      throw new Error("ENOENT: no such file");
    });
    const send = toolOf(node);

    await send({ method: "send", peer: PEER_URL, text: "hi" });
    expect(sent[0]?.metadata?.pod).not.toHaveProperty("files");

    await expect(send({ method: "send", peer: PEER_URL, text: "hi", files: ["missing.txt"] })).rejects.toThrow(
      /cannot hand over missing.txt: ENOENT/,
    );
    expect(sent).toHaveLength(1);
  });
});

describe("orca_pod fetch", () => {
  /** A node whose mesh serves `content` for whatever it is asked. */
  function fetchingNode(content: string) {
    const asked: Array<[string, string]> = [];
    const node = {
      mesh: {
        require: (nodeId: string) => ({
          fetchBlob: async (blobId: string) => {
            asked.push([nodeId, blobId]);
            return { stream: Readable.from([Buffer.from(content)]), size: Buffer.byteLength(content) };
          },
        }),
      },
    } as unknown as Orca;
    return { node, asked };
  }

  it("saves the file where the session sandbox allows writing, checked against the hash in its name", async () => {
    const root = tempRoot();
    const { node, asked } = fetchingNode("the result");
    const ref = blobRefText({ node: PEER, blob: sha256("the result") });

    const result = await toolOf(
      node,
      policyOf("workspace-write", root),
    )({ method: "fetch", ref, output: "out/result.txt" });

    expect(asked).toEqual([[PEER, sha256("the result")]]);
    expect(readFileSync(join(root, "out", "result.txt"), "utf8")).toBe("the result");
    expect(JSON.stringify(result)).toContain("result.txt");
  });

  it("writes nothing when the bytes are not the ones the name promises", async () => {
    const root = tempRoot();
    const { node } = fetchingNode("something else");
    const ref = blobRefText({ node: PEER, blob: sha256("what was promised") });

    await expect(
      toolOf(node, policyOf("workspace-write", root))({ method: "fetch", ref, output: "result.txt" }),
    ).rejects.toThrow(/nothing was written/);
    expect(existsSync(join(root, "result.txt"))).toBe(false);
    expect(existsSync(join(root, "result.txt.part"))).toBe(false);
  });

  it.each([
    ["a read-only session", policyOf("read-only", tmpdir()), join(tmpdir(), "orca-tool-files-x.txt")],
    // workspace-write also allows the platform temp dir, so the target has to be somewhere else: the repo.
    ["a path outside the session workspace", policyOf("workspace-write", tmpdir()), join(process.cwd(), "x.txt")],
  ])("refuses to write for %s, and fetches nothing", async (_label, policy, output) => {
    const { node, asked } = fetchingNode("x");
    const ref = blobRefText({ node: PEER, blob: sha256("x") });

    await expect(toolOf(node, policy)({ method: "fetch", ref, output })).rejects.toThrow(/does not allow writing/);
    expect(asked).toEqual([]);
  });

  it("writes anywhere under danger-full-access, and nowhere when the sandbox policy cannot be read", async () => {
    const root = tempRoot();
    const { node } = fetchingNode("x");
    const ref = blobRefText({ node: PEER, blob: sha256("x") });

    await toolOf(node, policyOf("danger-full-access", tmpdir()))({ method: "fetch", ref, output: join(root, "x.txt") });
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("x");

    await expect(toolOf(node)({ method: "fetch", ref, output: join(root, "y.txt") })).rejects.toThrow(
      /sandbox policy is not available/,
    );
  });

  it("needs a ref that names a published file", async () => {
    await expect(toolOf(fetchingNode("x").node)({ method: "fetch", ref: "not-a-ref", output: "x" })).rejects.toThrow(
      /ref must be <orca node id>\/<sha256>/,
    );
  });
});
