/**
 * Session binding: keeps the one ACP connection of an orca node alive and maps
 * (origin orca node, context) to an ACP session, resuming the persisted
 * binding when the child still knows it.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";

import type { ExecuteInput } from "../executor.ts";
import { describeIssue, parseSchema } from "../../kernel/schema.ts";
import { errorMessage } from "../../kernel/errors.ts";
import type { NodeLogger } from "../../kernel/events.ts";
import type { AcpMcpServer } from "./config.ts";
import { AcpConnection, HANDSHAKE_TIMEOUT_MS, spawnAcpChild, type AcpSpawnSpec } from "./connection.ts";

/** JSON-RPC code ACP agents use for a session they do not know. */
const RESOURCE_NOT_FOUND = -32002;

/**
 * Executor session bindings persisted under `<data_root>/state/<workgroup>/sessions.json`
 * (the task's `podDir`): session key → ACP session id.
 */
const SessionBindingsSchema = z.record(z.string(), z.string());
type SessionBindings = z.infer<typeof SessionBindingsSchema>;

/** Missing file means no bindings yet; a corrupt one throws instead of being overwritten by the next write. */
async function readSessions(podDir: string): Promise<SessionBindings> {
  const path = join(podDir, "sessions.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = parseSchema(SessionBindingsSchema, JSON.parse(text));
  if (!parsed.ok) throw new Error(`${path} is not a map of session ids: ${describeIssue(parsed.issue)}`);
  return parsed.value;
}

async function writeSessions(podDir: string, sessions: SessionBindings): Promise<void> {
  const path = join(podDir, "sessions.json");
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

type AcpSessionsOptions = {
  spawn: Omit<AcpSpawnSpec, "cwd">;
  mcpServers: AcpMcpServer[];
  logger: NodeLogger;
};

type OpenSession = { connection: AcpConnection; sessionId: string };

type AcpSessions = {
  open(input: ExecuteInput): Promise<OpenSession>;
  /** Close the connection; resolves once its child has exited. */
  close(): Promise<void>;
};

/** ACP wants `args` and `env` always present, and `env` as name/value pairs. */
function toAcpMcpServers(servers: AcpMcpServer[]): McpServer[] {
  return servers.map(({ name, command, args, env }) => ({
    name,
    command,
    args: args ?? [],
    env: Object.entries(env ?? {}).map(([key, value]) => ({ name: key, value })),
  }));
}

export function createAcpSessions({ spawn, mcpServers: configured, logger }: AcpSessionsOptions): AcpSessions {
  const mcpServers = toAcpMcpServers(configured);
  /** Session ids belong to one connection: a fresh child cannot resume ids cached for the old one. */
  let current: { connection: AcpConnection; sessions: Map<string, string> } | null = null;

  async function connect(cwd: string): Promise<{ connection: AcpConnection; sessions: Map<string, string> }> {
    if (current === null || current.connection.isClosed()) {
      current = { connection: new AcpConnection(spawnAcpChild({ ...spawn, cwd })), sessions: new Map() };
    }
    const joined = current;
    await joined.connection.ready;
    return joined;
  }

  async function resume(connection: AcpConnection, sessionId: string, cwd: string): Promise<boolean> {
    try {
      await connection.request("session/resume", { sessionId, cwd, mcpServers }, HANDSHAKE_TIMEOUT_MS);
      return true;
    } catch (error) {
      if (!(error instanceof RequestError && error.code === RESOURCE_NOT_FOUND)) {
        logger.warn(`acp session/resume failed, starting a new session: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  async function open(input: ExecuteInput): Promise<OpenSession> {
    const cwd = input.workspaceDir;
    const { connection, sessions } = await connect(cwd);
    const key = `acp|${input.originOrcaNode}|${input.contextId}`;
    const active = sessions.get(key);
    if (active !== undefined) return { connection, sessionId: active };

    const bindings = await readSessions(input.podDir);
    const bound = bindings[key];
    if (bound !== undefined && (await resume(connection, bound, cwd))) {
      sessions.set(key, bound);
      return { connection, sessionId: bound };
    }
    const created = await connection.request("session/new", { cwd, mcpServers }, HANDSHAKE_TIMEOUT_MS);
    // Responses are typed, not validated: a broken server must not bind `undefined`.
    if (typeof created?.sessionId !== "string") throw new Error("acp server returned no session id");
    sessions.set(key, created.sessionId);
    bindings[key] = created.sessionId;
    await writeSessions(input.podDir, bindings);
    return { connection, sessionId: created.sessionId };
  }

  async function close(): Promise<void> {
    const closing = current?.connection.close();
    current = null;
    await closing;
  }

  return { open, close };
}
