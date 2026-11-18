/**
 * Orca Pod panel — DSH client bundle entry (§9.2).
 *
 * `npm run build` (through `scripts/build-client.ts`) bundles this module and its imports into
 * `lib/client.js`, a classic script that registers a lazy factory with
 * `window.__ModuleLoader__`. The factory's `require` resolves only the shell's
 * platform module table (`react`, `react/jsx-runtime` and DSH's shared UI
 * primitives); host code is reached through the same-origin `/orca-api`
 * routes registered by `src/plugin/panel-routes.ts`.
 *
 * The host sends ready-to-render data (names, labels, links, what is
 * cancellable); the client only draws it and posts the user's actions back.
 *
 * UI rules: render inside a Slot, build on DSH's client UI primitives (types from `@deepseek-ai/dsh-client-ui-primitives`),
 * lay out with CSS modules that use only `--dsw-*` theme tokens, never touch
 * `document.body`, and keep all DOM work inside React. The one exception is
 * each CSS module's `<style>` tag, injected into `<head>` at materialization
 * the way DSH's own plugins do (see `scripts/build-client.ts`).
 */

import { ApprovalDock, ApprovalPopup } from "./approvals.tsx";
import { NS } from "./constants.ts";
import { TEXT, bindTranslate, t } from "./i18n.ts";
import { OverlayPanel, Panel, SidebarAction } from "./panel.tsx";
import { store } from "./store.ts";
import type { ClientContext } from "./types.ts";

/** Client services the shell must provide before `apply` runs. */
export const inject = ["slots", "locale"];

/** Register a settings page, a sidebar entry, the floating panel and the approval cards. */
export function apply(ctx: ClientContext): void {
  store.locale = ctx.locale;
  // Strings belong to the Client locale service: register the two
  // baseline dictionaries once, then translate through the bound namespace
  // so the panel follows the same language switch as the rest of the shell.
  // Registrations are effects so a plugin reload can register again after
  // the previous fiber's disposers ran.
  ctx.effect(() => ctx.locale.register(NS, "en", TEXT.en), "orca-pod.locale-en");
  ctx.effect(() => ctx.locale.register(NS, "zh", TEXT.zh), "orca-pod.locale-zh");
  bindTranslate(ctx.locale.bind(NS));
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register({ name: "settings.section", id: NS, order: 60, label: () => t("nav") }, Panel),
  );
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register({ name: "sidebar.footer.action", id: NS, order: 10, label: () => t("nav") }, SidebarAction),
  );
  ctx.slots.inject("shell.overlay", () => {
    ctx.slots.register({ name: "shell.overlay", id: `${NS}.panel`, order: 60 }, OverlayPanel);
    ctx.slots.register({ name: "shell.overlay", id: `${NS}.approval-popup`, order: 61 }, ApprovalPopup);
  });
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register({ name: "conversation.input.dock", id: `${NS}.approval-dock`, order: 60 }, ApprovalDock),
  );
}
