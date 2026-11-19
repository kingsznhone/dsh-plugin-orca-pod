import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context, Logger } from "@deepseek-ai/cordis";
import { vi } from "vitest";

import type { Orca } from "../../src/node/orca.ts";
import { ModelCatalogFeed } from "../../src/plugin/catalog.ts";
import { Pod } from "../../src/plugin/pod.ts";
import { PASSWORD_REF } from "../../src/plugin/stores.ts";
import { credentialHost, MemoryCredentials } from "./credentials.ts";

export const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** A catalog feed that follows no host services: `watch` is never called on it. */
export function catalogFeed(): ModelCatalogFeed {
  return new ModelCatalogFeed({ inject() {} } as unknown as Pick<Context, "inject">, logger);
}

/**
 * A real pod that was never started: no node, nothing configured. `settings`
 * are what the settings file holds; a `workgroup_password` among them is stored
 * as the password instead, the way the panel would, because the file never holds it.
 * `credentials` is the host's credential store the pod's stores read.
 */
export function idlePod(
  settings: Record<string, unknown> = {},
  credentials = new MemoryCredentials(),
  root = join(tmpdir(), `orca-pod-idle-${randomBytes(6).toString("hex")}`),
): Pod {
  const { workgroup_password: password, ...rest } = settings;
  if (typeof password === "string" && password.length > 0) credentials.secrets.set(PASSWORD_REF, password);
  if (Object.keys(rest).length > 0) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "settings.json"), JSON.stringify(rest));
  }
  return new Pod(logger, credentialHost(credentials), catalogFeed(), root);
}

/**
 * A pod that is running the given node, the way one that started it
 * would be. Tests pass the few parts of a node they exercise.
 */
export function podRunning(node: unknown): Pod {
  const pod = idlePod();
  vi.spyOn(pod, "status", "get").mockReturnValue({ kind: "running", orca: node as Orca });
  return pod;
}
