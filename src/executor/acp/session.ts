/**
 * Session binding: keeps the one ACP connection of an orca node alive and maps
 * (origin orca node, context) to an ACP session, resuming the persisted
 * binding when the child still knows it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import {
  RequestError,
  type ErrorCode,
  type McpServerStdio,
  type PromptResponse,
  type SessionConfigOption,
  type SessionConfigOptionCategory,
} from "@agentclientprotocol/sdk";
import { z } from "zod";

import type { ExecuteInput } from "../executor.ts";
import { describeIssue, parseSchema } from "../../core/schema.ts";
import { errorMessage, isMissingFile } from "../../core/errors.ts";
import type { NodeLogger } from "../../core/events.ts";
import { describeModelRequest } from "../../core/wire/model.ts";
import type { AcpMcpServer } from "./config.ts";
import { AcpConnection, HANDSHAKE_TIMEOUT_MS, type AcpSpawnSpec, type SessionRoute } from "./connection.ts";

/** JSON-RPC code ACP agents use for a session they do not know. */
const RESOURCE_NOT_FOUND: ErrorCode = -32002;

/**
 * Executor session bindings persisted under `<data_root>/state/<workgroup>/sessions.json`
 * (the task's `podDir`): session key → ACP session id.
 */
const SessionBindingsSchema = z.record(z.string(), z.string());
type SessionBindings = z.infer<typeof SessionBindingsSchema>;

/**
 * One open ACP session and the config options the agent last reported for it
 * (model, reasoning effort): selecting a model can change which efforts exist,
 * so the session replaces them with what each `set_config_option` returns.
 */
export class AcpSession {
  constructor(
    private readonly connection: AcpConnection,
    readonly id: string,
    private options: SessionConfigOption[],
  ) {}

  /**
   * ACP selects the model per session (§6.15) through the session's config
   * options, found by their ACP category (`model`, `thought_level`) rather than
   * by id; the ACP server rejects unknown values. The effort is
   * written only when the task (or the node default) supplies one: DeepSeek
   * models expose a fixed default effort, and dsh-acp rejects the empty
   * "provider default" value for them. Returns why it failed, or null.
   */
  async selectModel(
    model: ModelSelection | undefined,
    reasoningEffort: ReasoningEffortId | undefined,
  ): Promise<string | null> {
    try {
      // dsh-acp names a model option by its route, `[provider, model]` as JSON.
      if (model !== undefined) await this.setOption("model", JSON.stringify([model.provider, model.model]));
      if (reasoningEffort !== undefined) await this.setOption("thought_level", reasoningEffort);
      return null;
    } catch (error) {
      return `cannot select ${describeModelRequest(model, reasoningEffort)}: ${errorMessage(error)}`;
    }
  }

  /** Run one prompt to its stop reason. */
  prompt(text: string): Promise<PromptResponse> {
    return this.connection.request("session/prompt", { sessionId: this.id, prompt: [{ type: "text", text }] });
  }

  /** Route the child's messages for this session to `route` until the returned function is called. */
  attach(route: SessionRoute): () => void {
    return this.connection.attach(this.id, route);
  }

  isAttached(route: SessionRoute): boolean {
    return this.connection.isAttached(this.id, route);
  }

  /** Tell the child to stop the current prompt; it answers the prompt with `cancelled`. */
  cancel(): void {
    this.connection.cancel(this.id);
  }

  /** Close the connection and its child, which every session of the pool shares. */
  forceClose(): Promise<void> {
    return this.connection.close();
  }

  /** Set the option the agent files under `category`; the agent answers with its options as they are now. */
  private async setOption(category: SessionConfigOptionCategory, value: string): Promise<void> {
    const option = this.options.find((candidate) => candidate.category === category);
    if (option === undefined) throw new Error(`the agent offers no "${category}" option`);
    const answer = await this.connection.request("session/set_config_option", {
      sessionId: this.id,
      configId: option.id,
      value,
    });
    this.options = answer?.configOptions ?? this.options;
  }
}

export class AcpSessionPool {
  private readonly mcpServers: McpServerStdio[];
  /** Session ids belong to one connection: a fresh child cannot resume ids cached for the old one. */
  private current: { connection: AcpConnection; sessions: Map<string, AcpSession> } | null = null;

  constructor(
    private readonly spawn: Omit<AcpSpawnSpec, "cwd">,
    mcpServers: AcpMcpServer[],
    private readonly logger: NodeLogger,
  ) {
    // ACP wants `args` and `env` always present, and `env` as name/value pairs.
    this.mcpServers = mcpServers.map(({ name, command, args, env }) => ({
      name,
      command,
      args: args ?? [],
      env: Object.entries(env ?? {}).map(([key, value]) => ({ name: key, value })),
    }));
  }

  async open(input: ExecuteInput): Promise<AcpSession> {
    const cwd = input.workspaceDir;
    const { connection, sessions } = await this.connect(cwd);
    const key = `acp|${input.originOrcaNode}|${input.contextId}`;
    const active = sessions.get(key);
    if (active !== undefined) return active;

    const bindings = await this.loadBindings(input.podDir);
    const bound = bindings[key];
    const resumed = bound === undefined ? null : await this.resume(connection, bound, cwd);
    if (bound !== undefined && resumed !== null) {
      const session = new AcpSession(connection, bound, resumed);
      sessions.set(key, session);
      return session;
    }
    const created = await connection.request("session/new", { cwd, mcpServers: this.mcpServers }, HANDSHAKE_TIMEOUT_MS);
    // Responses are typed, not validated: a broken server must not bind `undefined`.
    if (typeof created?.sessionId !== "string") throw new Error("acp server returned no session id");
    const session = new AcpSession(connection, created.sessionId, created.configOptions ?? []);
    sessions.set(key, session);
    bindings[key] = created.sessionId;
    await this.saveBindings(input.podDir, bindings);
    return session;
  }

  /** Close the connection; resolves once its child has exited. */
  async close(): Promise<void> {
    const closing = this.current?.connection.close();
    this.current = null;
    await closing;
  }

  private async connect(cwd: string): Promise<{ connection: AcpConnection; sessions: Map<string, AcpSession> }> {
    if (this.current === null || this.current.connection.isClosed()) {
      this.current = { connection: AcpConnection.spawn({ ...this.spawn, cwd }), sessions: new Map() };
    }
    const joined = this.current;
    await joined.connection.ready;
    return joined;
  }

  /** The session's config options after a resume; null when the agent no longer knows it. */
  private async resume(
    connection: AcpConnection,
    sessionId: string,
    cwd: string,
  ): Promise<SessionConfigOption[] | null> {
    try {
      const resumed = await connection.request(
        "session/resume",
        { sessionId, cwd, mcpServers: this.mcpServers },
        HANDSHAKE_TIMEOUT_MS,
      );
      return resumed?.configOptions ?? [];
    } catch (error) {
      if (!(error instanceof RequestError && error.code === RESOURCE_NOT_FOUND)) {
        this.logger.warn(`acp session/resume failed, starting a new session: ${errorMessage(error)}`);
      }
      return null;
    }
  }

  /** Missing file means no bindings yet; a corrupt one throws instead of being overwritten by the next write. */
  private async loadBindings(podDir: string): Promise<SessionBindings> {
    const path = join(podDir, "sessions.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    const parsed = parseSchema(SessionBindingsSchema, JSON.parse(text));
    if (!parsed.ok) throw new Error(`${path} is not a map of session ids: ${describeIssue(parsed.issue)}`);
    return parsed.value;
  }

  private async saveBindings(podDir: string, bindings: SessionBindings): Promise<void> {
    await writeFileAtomic(join(podDir, "sessions.json"), `${JSON.stringify(bindings, null, 2)}\n`, { mode: 0o600 });
  }
}
