/**
 * First-party modules. Everything in `src/` is one package so the DSH bundle
 * installs self-contained; modules stay single-purpose files, and dependency
 * direction is kept by review rather than by package boundaries.
 */

export * from "./protocol.ts";
export * from "./crypto.ts";
export * from "./config.ts";
export * from "./storage.ts";
export * from "./gateway.ts";
export * from "./membership.ts";
export * from "./executor.ts";
export * from "./tasks.ts";
export * from "./node.ts";
export * from "./harness.ts";

/** DSH host bundle entry points (consumed by `cordis.patch.yml`). */
export { Config, apply, inject } from "./plugin/index.ts";
export type { Config as PodConfig } from "./plugin/index.ts";
