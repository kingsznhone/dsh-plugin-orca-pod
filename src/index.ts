/**
 * Package entry. Everything in `src/` is one package so the DSH bundle installs
 * self-contained; this file lists the two deliberate public surfaces:
 * the DSH bundle contract and the embeddable node API. Anything else is
 * imported from its own module.
 */

/** DSH host bundle entry points (consumed by `cordis.patch.yml`). */
export { Config, apply, inject } from "./plugin/bundle.ts";

/** Embeddable node API. */
export { createOrcaNodeConfig } from "./node/config.ts";
export type { OrcaNodeConfig } from "./node/config.ts";
export { PodError } from "./core/errors.ts";
export type { PodErrorCode } from "./core/errors.ts";
export { createOrcaNode, createPersistentStorage } from "./node/orca-node.ts";
export type { CreateNodeOptions, OrcaNode, OrcaNodeStorage } from "./node/orca-node.ts";
export type { ApprovalOptions } from "./task/delegation.ts";
export type { FetchLike } from "./mesh/peer-client.ts";
export type { NodeLogger } from "./core/events.ts";
export { ConfigValidationError, parseSettings, safeParseSettings } from "./node/settings.ts";
export type { Settings } from "./node/settings.ts";
export type { SchemaIssue } from "./core/schema.ts";
