/**
 * Shared child-process helpers for the executors: command resolution, Windows
 * `.cmd` shim quoting, process-tree termination, and abort errors.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export const KILL_GRACE_MS = 2_000;

/**
 * On Windows `dsh` is a `.cmd` shim, which `spawn` cannot execute directly.
 * Resolve it through PATH+PATHEXT so we can go through cmd.exe deliberately.
 */
export function resolveCommand(command: string): string {
  if (process.platform !== "win32" || extname(command)) return command;
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export function quoteForCmd(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

/** True when the resolved executable is a Windows shell shim needing cmd.exe. */
export function isCmdShim(resolved: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
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

export function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
