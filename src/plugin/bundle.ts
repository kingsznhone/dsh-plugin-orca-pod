/**
 * `orca-pod` — DeepSeek Harness host-side bundle for Orca.
 *
 * The bundle creates one Orca node from the plugin config, starts it without
 * blocking the DSH host, registers the `orca_pod` tool, and stops the orca node when
 * the plugin fiber unloads. There are no module-level side effects: the orca node is
 * only created inside `apply`.
 *
 * Optional host services are declared with `ctx.inject`. Each callback runs in
 * its own child scope and may run again when the service is replaced, so every
 * registration made there is tied to that scope's `effect`, never to the plugin's.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { StandardSchemaV1 } from "@standard-schema/spec";
// `ctx.settings` is this plugin's own injection; the service package owns the type.
import type {} from "@deepseek-ai/dsh-settings";

import { createApprovalBroker } from "./broker.ts";
import { createPodAdmin } from "./admin.ts";
import { createConfigSchema } from "./config.ts";
import type { Config as PodConfig } from "./config.ts";
import { defaultDataRoot } from "../node/config.ts";
import { createModelCatalogFeed } from "./catalog.ts";
import { startPod, stopPod } from "./lifecycle.ts";
import { createHostStores } from "./stores.ts";
import { optionalService } from "./services.ts";
import { skillRegistration } from "./skill.ts";
import { createPodTools } from "./tools.ts";
import { createTracker, restoreTrackedDispatches } from "./tracker.ts";
import { registerPodWeb } from "./web.ts";

/** Validated plugin configuration. */
export type Config = PodConfig;

/** Standard Schema config consumed by Cordis before `apply` runs. */
export const Config: StandardSchemaV1<unknown, Config> = createConfigSchema();

/**
 * Hard dependencies: the tool registry, the credential store that holds the
 * workgroup password, and the config editor the panel saves through. All three
 * are part of the DSH base composition.
 */
export const inject: string[] = ["tools", "credentials", "configEditor"];

/**
 * Compose the plugin: runtime, approval broker, tracker, tool, panel route.
 *
 * Startup is asynchronous and never throws into the host: a failed orca node start
 * is logged and surfaced through the tools (they report "orca node is not
 * running"), while `apply` returns immediately.
 */
export function apply(ctx: Context, config: Config): void {
  // The host does not export DSH_PROFILE_DIR to its own plugins, so the loader
  // baseUrl is the profile hint that keeps two profiles apart.
  const logger = ctx.logger("orca-pod");
  const defaultRoot = defaultDataRoot(process.env, ctx.baseUrl);
  const catalog = createModelCatalogFeed(ctx, logger);
  const handle = startPod(config, logger, createHostStores(ctx), { onNodeStarted: catalog.advertise }, defaultRoot);
  catalog.watch(handle);
  const node = () => handle.runtime.orcaNode;
  const broker = createApprovalBroker(node);
  const tracker = createTracker(node, broker, logger);

  /**
   * Resume tracking from the dispatch log (§8.3). Without `agent`, every session
   * the host already runs is considered (startup, or the agent registry
   * appearing); with `agent`, only that session's own dispatches. Repeating it
   * is harmless: watched or abandoned tasks are left alone.
   */
  const restore = (agent?: Agent): void => {
    const orcaNode = node();
    if (orcaNode === null) return;
    restoreTrackedDispatches(
      tracker,
      orcaNode.listDispatches(),
      (id) => (agent !== undefined ? agent : agents.current()?.get(id as SessionId)),
      logger,
      agent?.id,
    );
  };

  const agents = optionalService(ctx, "agents", "orca-pod.agents", (service) => {
    if (service !== undefined) void handle.ready.then(() => restore());
  });

  // Per-agent bookkeeping belongs to the agent's own fiber: the tracker forgets
  // the session when it is disposed, and a session created while the host runs
  // (including one resumed after a restart) picks up its own dispatches.
  ctx.on("agent/created", ({ agent }) => {
    agent.ctx.effect(() => () => tracker.forget(agent.id), "orca-pod.track");
    void handle.ready.then(() => restore(agent));
  });

  // A new user message gives the agent a fresh budget of tracker wake-ups.
  ctx.on("agent/inbox/claimed", ({ agent, message }) => {
    if (message.source?.kind === "user") tracker.resetWakes(agent.id);
  });

  // Cordis runs the returned disposer when the plugin fiber unloads (DSH exit,
  // reload, or the bundle being disabled). It awaits the orca node shutdown.
  ctx.effect(
    () => async () => {
      broker.clear();
      tracker.stop();
      await stopPod(handle, logger);
    },
    "orca-pod.orca-node",
  );

  const sandbox = optionalService(ctx, "sandboxPolicy", "orca-pod.sandbox-policy");

  // The tool is only visible once the workgroup credentials exist: before that
  // every call would fail with "not configured" and clutter the tool list.
  for (const tool of createPodTools(handle, tracker, sandbox.current)) {
    ctx.tools.register(tool, { when: () => handle.configured });
  }
  registerPodWeb(ctx, createPodAdmin(handle, tracker, broker));

  // The skill ships inside the package and is registered in memory; no copy is
  // written to a user skill root. ACP and CLI executors run in their own `dsh`
  // subprocesses and cannot see this host's registry, so they get
  // ORCA_POD_CLI/ORCA_POD_DATA_ROOT in their environment instead.
  if (config.skill_injection) {
    ctx.inject(["skills"], (scope) => {
      scope.effect(() => scope.skills.register(skillRegistration()), "orca-pod.skill");
    });
  }

  // The bundle renders its own settings section, so DSH must not also generate
  // an auto page from the Config schema.
  ctx.inject(["settings"], (scope) => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), "orca-pod.settings-page");
  });
}
