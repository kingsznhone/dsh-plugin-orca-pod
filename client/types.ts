/**
 * Types the panel shares with the host half and with DSH.
 *
 * The data shapes are the host's own (`src/plugin/admin.ts`, `src/plugin/web.ts`),
 * imported type-only so they are erased from the bundle: what the routes send
 * and what this client draws cannot drift apart. The DSH services are the
 * subset of `@deepseek-ai/dsh-client-locale` and the slot registry this bundle
 * uses; client plugins cannot import DSH packages at runtime.
 */

import type { ComponentType } from "react";

export type {
  PodAdvancedConfig,
  PodApproval,
  PodArtifact,
  PodChainEntry,
  PodConfigView,
  PodPeer,
  PodTaskDetail,
  PodTaskRow,
  WorkspaceView,
} from "../src/plugin/admin.ts";
export type { PodState } from "../src/plugin/web.ts";
export type { ModelOffer, ModelSelection } from "../src/protocol/model.ts";
export type { PeerView, RuntimeInfo } from "../src/protocol/peer.ts";
export type { PermissionMode } from "../src/protocol/permission.ts";

/** One namespace's strings for one language. */
export type LocaleDict = Record<string, string>;

/** Translate a key of a bound namespace; `params` fill `{name}` placeholders. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Client locale service (`ctx.locale`). Locale ids are short tags such as `en` or `zh`. */
export interface LocaleService {
  register(ns: string, locale: string, dict: LocaleDict): () => void;
  bind(ns: string): Translate;
  subscribe(listener: () => void): () => void;
  getLocale(): { active: string };
}

/** One slot contribution. */
export interface SlotRegistration {
  name: string;
  id: string;
  order: number;
  label?: () => string;
}

/** Client slot registry (`ctx.slots`). */
export interface SlotsService {
  /** Run `callback` once the named slot exists (and again when it is replaced). */
  inject(name: string, callback: () => void): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: each slot passes its own props to the component.
  register(slot: SlotRegistration, component: ComponentType<any>): () => void;
}

/** The client plugin context this bundle's `apply` receives. */
export interface ClientContext {
  locale: LocaleService;
  slots: SlotsService;
  effect(execute: () => () => void, label?: string): unknown;
}
