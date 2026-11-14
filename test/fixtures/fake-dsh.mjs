/**
 * Fake `dsh headless --json` used by test/headless.test.ts (§6.14).
 * Emits the same NDJSON shape as the real CLI; behavior is chosen by FAKE_DSH_MODE.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sessionId = option("--session-id");
const prompt = argv[argv.length - 1];
const mode = process.env.FAKE_DSH_MODE ?? "ok";
const argsFile = process.env.FAKE_DSH_ARGS_FILE;
if (argsFile) {
  mkdirSync(dirname(argsFile), { recursive: true });
  writeFileSync(argsFile, JSON.stringify({ argv, sessionId, prompt, cwd: process.cwd() }));
}

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sid = sessionId ?? "session-fake-1";
send({ type: "session", sessionId: sid, cwd: process.cwd() });
send({ type: "status", phase: "turn_start", turn: 1 });

if (mode === "error") {
  send({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { message: "boom" } } });
  send({ type: "final", sessionId: sid, reason: { kind: "error", error: { message: "boom" } }, text: "" });
  process.exit(0);
}
if (mode === "error-code") {
  const reason = { kind: "error", error: { message: "boom", code: "AUTH_MISSING" } };
  send({ type: "status", phase: "turn_end", turn: 1, reason });
  send({ type: "final", sessionId: sid, reason, text: "" });
  process.exit(0);
}
if (mode === "usage") {
  send({ type: "status", phase: "step_end", turn: 1, usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 3 } });
  send({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
  send({ type: "final", sessionId: sid, reason: { kind: "completed" }, text: "fake done" });
  process.exit(0);
}
if (mode === "nofinal") process.exit(0);
if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "resume-check") {
  if (!sessionId) {
    process.stderr.write("missing --session-id\n");
    process.exit(2);
  }
  send({ type: "final", sessionId: sid, reason: { kind: "completed" }, text: "resumed" });
  process.exit(0);
} else {
  send({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
  const text = mode === "echo-prompt" ? prompt : "fake done";
  send({ type: "final", sessionId: sid, reason: { kind: "completed" }, text });
  process.exit(0);
}
