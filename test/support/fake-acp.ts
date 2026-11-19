/**
 * A command that starts the fake ACP server (`test/fixtures/fake-acp.mjs`). The
 * ACP executor's setting names only a program, so the mode and the log path
 * ride in a small launcher script; whatever the executor appends (`--profile acp`)
 * reaches the server after them.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_ACP = fileURLToPath(new URL("../fixtures/fake-acp.mjs", import.meta.url));

/** Write a launcher into `dir` that runs the fake server in `mode`, logging to `log`; returns its path. */
export function fakeAcpCommand(dir: string, mode: string, log: string): string {
  if (process.platform === "win32") {
    const path = join(dir, `fake-acp-${mode}.cmd`);
    writeFileSync(path, `@"${process.execPath}" "${FAKE_ACP}" ${mode} "${log}" %*\r\n`);
    return path;
  }
  const path = join(dir, `fake-acp-${mode}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACP}" ${mode} "${log}" "$@"\n`, { mode: 0o755 });
  return path;
}
