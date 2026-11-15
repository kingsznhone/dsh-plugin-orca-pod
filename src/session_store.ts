/** Executor session bindings persisted under `<workspace>/.pod/sessions.json`. */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SessionBindings = Record<string, string>;

export async function readSessions(podDir: string): Promise<SessionBindings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(podDir, "sessions.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as SessionBindings)
      : {};
  } catch {
    return {};
  }
}

export async function writeSessions(podDir: string, sessions: SessionBindings): Promise<void> {
  const path = join(podDir, "sessions.json");
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
