/**
 * Session binding: keeps the one ACP connection of an orca node alive and maps
 * (origin orca node, context) to an ACP session, resuming the persisted
 * binding when the child still knows it.
 */

import type { ExecuteInput } from "../executor.ts";
import type { NodeLogger } from "../mesh.ts";
import { readSessions, writeSessions } from "../session_store.ts";
import { isRecord } from "../protocol.ts";
import type { AcpMcpServer } from "../settings.ts";
import { AcpConnection, AcpRpcError, HANDSHAKE_TIMEOUT_MS, spawnAcpChild, type AcpSpawnSpec } from "./connection.ts";
import { errorMessage } from "../errors.ts";

/** JSON-RPC code ACP agents use for a session they do not know. */
const RESOURCE_NOT_FOUND = -32002;

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

export function createAcpSessions({ spawn, mcpServers, logger }: AcpSessionsOptions): AcpSessions {
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
      if (!(error instanceof AcpRpcError && error.code === RESOURCE_NOT_FOUND)) {
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
    if (!isRecord(created) || typeof created.sessionId !== "string")
      throw new Error("acp server returned no session id");
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
