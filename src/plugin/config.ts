/**
 * Configuration for the `orca-pod` DSH bundle.
 *
 * The plugin `Config` is the node `Settings`, and its Standard Schema (v1)
 * validator is the shared settings parser: Cordis only requires
 * `Config['~standard'].validate`, and this workspace does not resolve
 * `@deepseek-ai/*` runtime packages (Schemastery is one of them).
 *
 * One rule is added on top: the plugin config never carries the workgroup
 * password. It lives in the DSH credential store under `workgroup_password_ref`
 * (§7.3), so the profile patch stays safe to sync, render and log; a plaintext
 * `workgroup_password` in the config is a validation error.
 */

import { safeParseSettings } from "../node/settings.ts";
import type { Settings } from "../node/settings.ts";
import { isRecord } from "../kernel/schema.ts";

import type { StandardSchemaV1 } from "./dsh.ts";

/** Validated configuration accepted by the ORCA pod bundle. */
export type Config = Settings;

/** Parse a plugin config: the shared settings parser, minus the plaintext password. */
export function validatePluginConfig(input: unknown): ReturnType<typeof safeParseSettings> {
  if (isRecord(input) && typeof input.workgroup_password === "string" && input.workgroup_password.length > 0) {
    return {
      issues: [
        {
          message:
            "is not accepted in the plugin config; the password is kept in the DSH credential store (set it from the panel, or name an existing credential with workgroup_password_ref)",
          path: ["workgroup_password"],
        },
      ],
    };
  }
  return safeParseSettings(input);
}

/** Create the Standard Schema validator Cordis consumes as the plugin `Config`. */
export function createConfigSchema(): StandardSchemaV1<Config> {
  return { "~standard": { version: 1, vendor: "orca-pod", validate: validatePluginConfig } };
}
