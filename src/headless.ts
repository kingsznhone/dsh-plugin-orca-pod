/**
 * HeadlessExecutor (§6.14): one `dsh headless --json` child process per task.
 * NDJSON events are translated into LocalExecutor events; the session id is
 * bound per (origin orca node, context) so the next task can resume it.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HeadlessExecutorConfig } from "./config.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "./executor.ts";
import { KILL_GRACE_MS, abortError, isCmdShim, killTree, quoteForCmd, resolveCommand } from "./process.ts";
import { readSessions, writeSessions } from "./session-store.ts";

const STDERR_TAIL = 4096;

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

      const resolved = resolveCommand(command);
      // .cmd/.bat shims only run through cmd.exe; hand the prompt over stdin
      // ("-" positional) so the command line never needs shell quoting.
      const viaCmd = isCmdShim(resolved);

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
        viaCmd ? "-" : input.prompt,
      ];

      const child = viaCmd
        ? spawn(
            process.env.ComSpec ?? "cmd.exe",
            ["/d", "/s", "/c", `"${[quoteForCmd(resolved), ...args.map(quoteForCmd)].join(" ")}"`],
            {
              cwd: input.workspaceDir,
              windowsHide: true,
              windowsVerbatimArguments: true,
              stdio: ["pipe", "pipe", "pipe"],
            },
          )
        : spawn(resolved, args, {
            cwd: input.workspaceDir,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            ...(process.platform === "win32" ? {} : { detached: true }),
          });

      if (viaCmd) child.stdin?.end(input.prompt);

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
