/**
 * Value lists the protocol offers as panel choices.
 *
 * Kept here because the client bundle may not import a host package at runtime;
 * the type-only import below is erased when that bundle is built.
 */

/**
 * Reasoning efforts DSH's providers offer today. The protocol treats an effort
 * as an opaque string so a provider can add values; this list is what the
 * panel offers as a node default.
 */
export const KNOWN_REASONING_EFFORTS = ["off", "low", "high", "max"] as const;
