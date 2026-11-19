import { resolve } from "node:path";

import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/**
 * The data directory of the one orca node of this machine: `orca-pod` under the
 * DSH home (`$DSH_HOME`, default `~/.dsh`). A machine has one node however many
 * DSH profiles it runs, so settings, tasks and files are shared by all of them
 * (section 3.9 of the plan). There is no fallback to any earlier location.
 */
export function defaultDataRoot(
  /** The DSH home as the host resolved it (`ctx.dshHomePath()`); otherwise DSH's own rule over `env`. */
  dshHome?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(resolveDshHome(dshHome, env), "orca-pod");
}
