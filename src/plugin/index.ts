/**
 * `orca-pod` — DeepSeek Harness host-side bundle for Orca.
 *
 * The bundle creates one Orca node from the plugin config, starts it without
 * blocking the DSH host, registers the `orca_pod` tool, and stops the orca node when
 * the plugin fiber unloads. There are no module-level side effects: the orca node is
 * only created inside `apply`.
 */

import { createApprovalBroker } from "./broker.ts";
import { createPodAdmin } from "./admin.ts";
import { createConfigSchema } from "./config.ts";
import type { Config as PodConfig } from "./config.ts";
import type { AgentsService, HostContext, PermissionPresetsService, StandardSchemaV1 } from "./dsh.ts";
import { createPodRuntime, stopPod } from "./lifecycle.ts";
import { installSkill } from "./skill.ts";
import { createPodTools } from "./tools.ts";
import { createTracker, restoreTrackedDispatches } from "./tracker.ts";
import { errorMessage } from "../errors.ts";
import { service } from "./util.ts";
import { registerPodWeb } from "./web.ts";

/** Validated plugin configuration. */
export type Config = PodConfig;

/** Standard Schema config consumed by Cordis before `apply` runs. */
export const Config: StandardSchemaV1<Config> = createConfigSchema();

/** Hard dependency on the DSH tool registry service. */
export const inject: string[] = ["tools"];

/**
 * Compose the plugin: runtime, approval broker, tracker, tool, panel route.
 *
 * Startup is asynchronous and never throws into the host: a failed orca node start
 * is logged and surfaced through the tools (they report "orca node is not
 * running"), while `apply` returns immediately.
 */
export function apply(ctx: HostContext, config: Config): void {
  const handle = createPodRuntime(ctx, config);
  const node = () => handle.runtime.orcaNode;
  const broker = createApprovalBroker(node);
  const tracker = createTracker(node, broker, ctx.logger);

  // Tasks dispatched before a host restart resume tracking for sessions that still run.
  void handle.ready.then(() => {
    const orcaNode = node();
    const agents = service<AgentsService>(ctx, "agents");
    if (orcaNode !== null)
      restoreTrackedDispatches(tracker, orcaNode.listDispatches(), (id) => agents?.get(id), ctx.logger);
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
      await stopPod(handle, ctx.logger);
    },
    "orca-pod.orca-node",
  );

  for (const tool of createPodTools(handle, tracker, service<PermissionPresetsService>(ctx, "permissionPresets"))) {
    ctx.tools.register(tool);
  }
  registerPodWeb(ctx, createPodAdmin(handle, tracker, broker));

  // ACP and CLI executors run in their own `dsh` subprocesses and cannot see
  // this host's tools; they get ORCA_POD_CLI/ORCA_POD_DATA_ROOT in their
  // environment instead. The skill bundle also ships in the package, so a
  // user-root copy is optional (off by default) and install is idempotent.
  if (config.skill_injection) {
    void installSkill().then(
      (installed) => {
        if (installed.written) ctx.logger.info(`orca-pod: installed skill at ${installed.path}`);
      },
      (error) => ctx.logger.warn(`orca-pod: could not install skill: ${errorMessage(error)}`),
    );
  }
}
