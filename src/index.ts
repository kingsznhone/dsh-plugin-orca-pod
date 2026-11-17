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
export { createOrcaNodeConfig } from "./node/index.ts";
export type { OrcaNodeConfig } from "./node/index.ts";
export { PodError } from "./kernel/index.ts";
export type { PodErrorCode } from "./kernel/index.ts";
export { createOrcaNode, createPersistentStorage } from "./node/index.ts";
export type {
  ApprovalOptions,
  CreateNodeOptions,
  FetchLike,
  NodeLogger,
  OrcaNode,
  OrcaNodeStorage,
} from "./node/index.ts";
export { ConfigValidationError, parseSettings, safeParseSettings } from "./node/index.ts";
export type { Settings, SettingsIssue } from "./node/index.ts";
