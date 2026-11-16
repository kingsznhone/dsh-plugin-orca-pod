/** Executor session bindings persisted under `<workspace>/.pod/sessions.json`. */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

type SessionBindings = Record<string, string>;

/** Missing file means no bindings yet; a corrupt one throws instead of being overwritten by the next write. */
export async function readSessions(podDir: string): Promise<SessionBindings> {
  const path = join(podDir, "sessions.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  if (!Object.values(parsed).every((value) => typeof value === "string")) {
    throw new Error(`${path} holds a non-string session id`);
  }
  return parsed as SessionBindings;
}

export async function writeSessions(podDir: string, sessions: SessionBindings): Promise<void> {
  const path = join(podDir, "sessions.json");
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
