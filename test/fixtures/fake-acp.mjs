/**
 * Minimal fake ACP server for AcpExecutor tests: NDJSON JSON-RPC on stdio.
 * Usage: node fake-acp.mjs <mode> <logFile>
 * Modes: ok | permission | permission-twice | permission-fetch | hang | resume-fail | crash-once
 * `permission` asks to edit (a kind workspace-write allows by itself);
 * `permission-twice` asks to edit, then once more after the first answer;
 * `permission-fetch` asks for a kind that only danger-full-access allows.
 * Every request/notification is appended to <logFile> as one JSON object per line.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Skip trailing option-looking args the executor appends (e.g. `--profile acp`):
// without this guard argv[3] would become a log path literally named "--profile".
const rawMode = process.argv[2] ?? "ok";
const mode = rawMode.startsWith("-")
  ? "ok"
  : rawMode === "permission-fetch" || rawMode === "permission-twice"
    ? "permission"
    : rawMode;
const askTwice = rawMode === "permission-twice";
let askedAgain = false;
const toolKind = rawMode === "permission-fetch" ? "fetch" : "edit";
const rawLog = process.argv[3] ?? null;
const logFile = rawLog !== null && !rawLog.startsWith("-") ? rawLog : null;
const sessions = new Set();
let counter = 0;
let permissionSeq = 1000;
const heldPrompts = new Map();
const permissionOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

/** The options dsh-acp reports, filed under the ACP categories the executor looks up. */
const CONFIG_OPTIONS = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "", options: [] },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "",
    options: [],
  },
];

function log(record) {
  if (logFile !== null) appendFileSync(logFile, `${JSON.stringify(record)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, message, code = -32602) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** ACP `McpServerStdio`: `args` and `env` are required, `env` is a list of name/value pairs. */
function badMcpServers(servers) {
  if (servers === undefined) return null;
  if (!Array.isArray(servers)) return "mcpServers must be an array";
  for (const [index, server] of servers.entries()) {
    if (!Array.isArray(server?.args)) return `mcpServers[${index}].args must be an array`;
    const env = server?.env;
    if (
      !Array.isArray(env) ||
      !env.every((entry) => typeof entry?.name === "string" && typeof entry?.value === "string")
    ) {
      return `mcpServers[${index}].env must be an array of {name, value}`;
    }
  }
  return null;
}

function update(sessionId, payload) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
}

function finishPrompt(sessionId, stopReason) {
  const held = heldPrompts.get(sessionId);
  if (held === undefined) return;
  heldPrompts.delete(sessionId);
  respond(held, { stopReason });
}

function promptTurn(id, params) {
  const sessionId = params.sessionId;
  const text = (params.prompt ?? []).map((part) => part.text ?? "").join("");
  log({ method: "session/prompt", sessionId, text });
  if (mode === "crash-once") {
    const marker = `${logFile ?? ""}.crashed`;
    if (!existsSync(marker)) {
      writeFileSync(marker, "1");
      process.stderr.write("fake-acp: crashing on purpose\n");
      process.exit(1);
    }
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: "m1",
    content: { type: "text", text: "acp " },
  });
  if (mode === "hang") {
    heldPrompts.set(sessionId, id);
    return;
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: "m1",
    content: { type: "text", text: "done" },
  });
  if (mode === "permission") {
    const requestId = permissionSeq++;
    heldPrompts.set(sessionId, id);
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "call-1", title: "write file", kind: toolKind },
        options: permissionOptions,
      },
    });
    return;
  }
  respond(id, { stopReason: "end_turn" });
}

function onRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    log({ method: "initialize", inTask: process.env.ORCA_POD_IN_TASK });
    respond(id, {
      protocolVersion: 1,
      agentInfo: { name: "fake-acp", version: "0.0.0" },
      agentCapabilities: {},
      authMethods: [],
    });
    return;
  }
  if (method === "session/new") {
    if (typeof params?.cwd !== "string") {
      fail(id, "cwd required");
      return;
    }
    const invalid = badMcpServers(params?.mcpServers);
    if (invalid !== null) {
      fail(id, invalid);
      return;
    }
    const sessionId = `fake-${++counter}`;
    sessions.add(sessionId);
    log({
      method: "session/new",
      sessionId,
      cwd: params.cwd,
      mcpServers: params?.mcpServers ?? [],
    });
    respond(id, { sessionId, configOptions: CONFIG_OPTIONS });
    return;
  }
  if (method === "session/resume") {
    if (mode === "resume-fail") {
      fail(id, "session not found", -32002);
      return;
    }
    const invalid = badMcpServers(params?.mcpServers);
    if (invalid !== null) {
      fail(id, invalid);
      return;
    }
    log({ method: "session/resume", sessionId: params?.sessionId });
    respond(id, { configOptions: CONFIG_OPTIONS });
    return;
  }
  if (method === "session/set_config_option") {
    log({
      method: "session/set_config_option",
      sessionId: params?.sessionId,
      configId: params?.configId,
      value: params?.value,
    });
    if (mode === "model-reject") {
      fail(id, `unknown model option: ${String(params?.value)}`);
      return;
    }
    respond(id, { configOptions: CONFIG_OPTIONS });
    return;
  }
  if (method === "session/prompt") {
    promptTurn(id, params ?? {});
    return;
  }
  fail(id, `unknown method ${method}`);
}

function onNotification(message) {
  log({ method: message.method, params: message.params });
  if (message.method === "session/cancel") {
    finishPrompt(message.params?.sessionId, "cancelled");
  }
}

function onResponse(message) {
  log({ responseTo: message.id, result: message.result });
  if (mode === "permission" && message.id >= 1000) {
    const outcome = message.result?.outcome;
    log({
      method: "permission_response",
      outcome: outcome?.outcome ?? null,
      optionId: outcome?.optionId ?? null,
    });
    const allowed = outcome?.outcome === "selected" && outcome?.optionId === "allow-once";
    if (askTwice && !askedAgain) {
      askedAgain = true;
      for (const sessionId of heldPrompts.keys()) {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          messageId: "m2",
          content: { type: "text", text: allowed ? "allowed" : "denied" },
        });
        send({
          jsonrpc: "2.0",
          id: permissionSeq++,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "call-2", title: "write another file", kind: toolKind },
            options: permissionOptions,
          },
        });
      }
      return;
    }
    for (const [sessionId, promptId] of heldPrompts) {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "m2",
        content: { type: "text", text: allowed ? "allowed" : "denied" },
      });
      heldPrompts.delete(sessionId);
      respond(promptId, { stopReason: "end_turn" });
      break;
    }
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof message.method === "string") {
    if (message.id !== undefined) onRequest(message);
    else onNotification(message);
  } else {
    onResponse(message);
  }
});
lines.on("close", () => process.exit(0));
