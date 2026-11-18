/**
 * Shared child-process helpers for the executors: process-tree termination and
 * abort errors. Windows `.cmd` shim resolution and quoting are `cross-spawn`'s
 * job, so no platform-specific command handling lives here.
 */

import { spawn, type ChildProcess } from "node:child_process";

export const KILL_GRACE_MS = 2_000;

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // dsh may spawn its own children; /T is the only portable way to reach them.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => child.kill());
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

/**
 * SIGTERM the child's process tree, SIGKILL after the grace period; resolves
 * once the child has exited, so callers can release its cwd safely.
 */
export function terminateChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killTree(child, "SIGTERM");
  });
}
