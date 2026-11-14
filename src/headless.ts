/**
 * HeadlessExecutor (§6.14): one `dsh headless --json` child process per task.
 * NDJSON events are translated into LocalExecutor events; the session id is
 * bound per (origin orca node, context) so the next task can resume it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HeadlessExecutorConfig } from "./config.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "./executor.ts";

const STDERR_TAIL = 4096;
const KILL_GRACE_MS = 2_000;

type DshReason = {
  kind?: unknown;
  error?: { message?: unknown } | null;
} | null;

type DshEvent = {
  type?: unknown;
  phase?: unknown;
  sessionId?: unknown;
  text?: unknown;
  reason?: DshReason;
};

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function failureOf(reason: DshReason | undefined): string | null {
  if (!reason) return null;
  if (reason.kind === "error") {
    return typeof reason.error?.message === "string" ? reason.error.message : "dsh reported an error";
  }
  if (reason.kind === "aborted") return "dsh run aborted";
  if (reason.kind === "interrupted") return "dsh run interrupted";
  return null;
}

function sessionKey(input: ExecuteInput): string | null {
  if (!input.originOrcaNode || !input.contextId) return null;
  return `${input.originOrcaNode}|${input.contextId}`;
}

async function readSessions(podDir: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(podDir, "sessions.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

async function writeSessions(podDir: string, sessions: Record<string, string>): Promise<void> {
  const path = join(podDir, "sessions.json");
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // dsh may spawn its own children; /T is the only portable way to reach them.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, signal); // detached => child is a process group leader
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export function createHeadlessExecutor(options: HeadlessExecutorConfig = {}): LocalExecutor {
  const command = options.command ?? "dsh";
  const profile = options.profile ?? "headless";
  const permissionMode = options.permission_mode ?? "read-only";
  const approvalPolicy = options.approval_policy ?? "never";
  const extraArgs = options.extra_args ?? [];

  return {
    async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, unknown> {
      if (!input.prompt) {
        yield { type: "failed", text: "task has no prompt text" };
        return;
      }

      const key = sessionKey(input);
      const sessions = key && input.podDir ? await readSessions(input.podDir) : {};
      const sessionId = key ? sessions[key] : undefined;

      const args = [
        ...extraArgs,
        "--profile",
        profile,
        "--json",
        "--permission-mode",
        permissionMode,
        "--approval-policy",
        approvalPolicy,
        ...(input.workspaceDir ? ["--add-dir", input.workspaceDir] : []),
        ...(sessionId ? ["--session-id", sessionId] : []),
        input.prompt,
      ];

      const child = spawn(command, args, {
        cwd: input.workspaceDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(process.platform === "win32" ? {} : { detached: true }),
      });

      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });

      let spawnError: string | null = null;
      child.on("error", (error: Error) => {
        spawnError = `cannot start ${command}: ${error.message}`;
      });

      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        killTree(child, "SIGTERM");
        setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS).unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      let finalText: string | null = null;
      let failure: string | null = null;
      let discoveredSession: string | undefined;
      const lines = createInterface({ input: child.stdout! });
      try {
        for await (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: DshEvent;
          try {
            event = JSON.parse(trimmed) as DshEvent;
          } catch {
            continue; // tolerate non-JSON noise on stdout
          }
          if (event.type === "session" && typeof event.sessionId === "string") {
            discoveredSession = event.sessionId;
          }
          if (event.type === "status" && event.phase === "turn_end") {
            const reason = failureOf(event.reason);
            if (reason) failure = reason;
          }
          if (event.type === "final") {
            finalText = typeof event.text === "string" ? event.text : "";
            const reason = failureOf(event.reason);
            if (reason) failure = reason;
          }
        }
      } finally {
        lines.close();
        signal.removeEventListener("abort", onAbort);
      }

      if (aborted) throw abortError();
      if (spawnError) {
        yield { type: "failed", text: spawnError };
        return;
      }

      if (key && discoveredSession && input.podDir && sessions[key] !== discoveredSession) {
        sessions[key] = discoveredSession;
        await writeSessions(input.podDir, sessions);
      }

      if (failure) {
        yield { type: "failed", text: failure };
        return;
      }
      if (finalText === null) {
        const tail = stderr.trim();
        yield { type: "failed", text: `dsh exited without a final event${tail ? `: ${tail}` : ""}` };
        return;
      }
      yield { type: "completed", text: finalText };
    },
  };
}
