/**
 * Configuration of the `orca-pod` DSH plugin: only what does not belong to the
 * node. The node's settings are one file for the whole machine, written by the
 * panel (`settings-file.ts`), because a profile's plugin config cannot be shared
 * by every profile (§3.9); the password is a DSH credential (§3.6).
 *
 * Its Standard Schema (v1) validator is all Cordis requires of a `Config`. Keys
 * it does not know are ignored, so an older profile patch that still carries
 * node settings loads; the panel asks for them again.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

import { isRecord } from "../core/schema.ts";

export type Config = {
  /** Register the bundled `orca-node` skill with the host's skills service. */
  skill_injection: boolean;
};

function validatePluginConfig(input: unknown): StandardSchemaV1.Result<Config> {
  if (input !== undefined && input !== null && !isRecord(input)) {
    return { issues: [{ message: "expected an object", path: [] }] };
  }
  const skill = isRecord(input) ? (input.skill_injection ?? undefined) : undefined;
  if (skill !== undefined && typeof skill !== "boolean") {
    return { issues: [{ message: "must be true or false", path: ["skill_injection"] }] };
  }
  return { value: { skill_injection: skill ?? false } };
}

/** Standard Schema config consumed by Cordis before `apply` runs. */
export const Config: StandardSchemaV1<unknown, Config> = {
  "~standard": { version: 1, vendor: "orca-pod", validate: validatePluginConfig },
};
