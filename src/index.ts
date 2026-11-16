/**
 * Package entry. Everything in `src/` is one package so the DSH bundle installs
 * self-contained; this file lists the two deliberate public surfaces:
 * the DSH bundle contract and the embeddable node API. Anything else is
 * imported from its own module.
 */

/** DSH host bundle entry points (consumed by `cordis.patch.yml`). */
export { Config, apply, inject } from "./plugin/index.ts";
export type { Config as PodConfig } from "./plugin/index.ts";

/** Embeddable node API. */
export { createOrcaNodeConfig } from "./config.ts";
export type { OrcaNodeConfig } from "./config.ts";
export { PodError } from "./errors.ts";
export type { PodErrorCode } from "./errors.ts";
export { createOrcaNode, createPersistentStorage } from "./orca_node.ts";
export type {
  ApprovalOptions,
  CreateNodeOptions,
  FetchLike,
  NodeLogger,
  OrcaNode,
  OrcaNodeStorage,
} from "./orca_node.ts";
export { ConfigValidationError, parseSettings, safeParseSettings } from "./settings.ts";
export type { Settings, SettingsIssue } from "./settings.ts";
