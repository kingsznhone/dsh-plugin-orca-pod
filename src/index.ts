/**
 * Package entry. Everything in `src/` is one package so the DSH bundle installs
 * self-contained; this file lists the two deliberate public surfaces:
 * the DSH bundle contract and the embeddable node API. Anything else is
 * imported from its own module.
 */

/** DSH host bundle entry points (consumed by `cordis.patch.yml`). */
export { Config, apply, inject } from "./plugin/bundle.ts";
export type { Config as PodConfig } from "./plugin/bundle.ts";

/** Embeddable node API. */
export { createOrcaNodeConfig } from "./node/config.ts";
export type { OrcaNodeConfig } from "./node/config.ts";
export { PodError } from "./kernel/errors.ts";
export type { PodErrorCode } from "./kernel/errors.ts";
export { createOrcaNode, createPersistentStorage } from "./node/orca-node.ts";
export type {
  ApprovalOptions,
  CreateNodeOptions,
  FetchLike,
  NodeLogger,
  OrcaNode,
  OrcaNodeStorage,
} from "./node/orca-node.ts";
export { ConfigValidationError, parseSettings, safeParseSettings } from "./node/settings.ts";
export type { Settings, SettingsIssue } from "./node/settings.ts";
