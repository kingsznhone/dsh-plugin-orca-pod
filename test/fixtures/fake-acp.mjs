/**
 * Minimal fake ACP server for AcpExecutor tests: NDJSON JSON-RPC on stdio.
 * Usage: node fake-acp.mjs <mode> <logFile>
 * Modes: ok | permission | hang | resume-fail
 * Every request/notification is appended to <logFile> as one JSON object per line.
 */

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "ok";
const logFile = process.argv[3] ?? null;
const sessions = new Set();
let counter = 0;
let permissionSeq = 1000;
const heldPrompts = new Map();
const permissionOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
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

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32602, message } });
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
        toolCall: { toolCallId: "call-1", title: "write file", kind: "edit" },
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
    log({ method: "initialize" });
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
    const sessionId = `fake-${++counter}`;
    sessions.add(sessionId);
    log({ method: "session/new", sessionId, cwd: params.cwd, mcpServers: Array.isArray(params?.mcpServers) ? params.mcpServers.length : 0 });
    respond(id, { sessionId });
    return;
  }
  if (method === "session/resume") {
    if (mode === "resume-fail") {
      fail(id, "session is not resumable");
      return;
    }
    log({ method: "session/resume", sessionId: params?.sessionId });
    respond(id, { sessionId: params?.sessionId });
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
    const allowed = outcome?.outcome === "selected" && outcome?.optionId === "allow-once";
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
