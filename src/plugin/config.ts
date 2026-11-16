/**
 * Configuration for the `orca-pod` DSH bundle.
 *
 * The plugin `Config` is the node `Settings`, and its Standard Schema (v1)
 * validator is the shared settings parser: Cordis only requires
 * `Config['~standard'].validate`, and this workspace does not resolve
 * `@deepseek-ai/*` runtime packages (Schemastery is one of them).
 *
 * SECURITY NOTE: `workgroup_password` is intentionally accepted as plaintext in
 * the patch config. A production bundle should read the workgroup password from
 * the DSH credentials service instead, so it never lands in `cordis.patch.yml`
 * or logs.
 */

import { safeParseSettings } from "../settings.ts";
import type { Settings } from "../settings.ts";

import type { StandardSchemaV1 } from "./dsh.ts";

/** Validated configuration accepted by the ORCA pod bundle. */
export type Config = Settings;

/** Create the Standard Schema validator Cordis consumes as the plugin `Config`. */
export function createConfigSchema(): StandardSchemaV1<Config> {
  return { "~standard": { version: 1, vendor: "orca-pod", validate: safeParseSettings } };
}
