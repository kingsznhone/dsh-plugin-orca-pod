/**
 * `orca-pod` — DeepSeek Harness host-side bundle for Orca.
 *
 * The bundle creates one Orca node from the plugin config, starts it without
 * blocking the DSH host, registers the `pod_*` tools, and stops the orca node when
 * the plugin fiber unloads. There are no module-level side effects: the orca node is
 * only created inside `apply`.
 */

import { createConfigSchema } from "./config.ts"
import type { Config as PodConfig } from "./config.ts"
import type { HostContext, HostLogger, StandardSchemaV1 } from "./dsh.ts"
import { startPod, stopPod } from "./lifecycle.ts"
import { createPodTools } from "./tools.ts"
import { createTracker } from "./tracker.ts"
import { errorMessage } from "./util.ts"

/** Validated plugin configuration. */
export type Config = PodConfig

/** Standard Schema config consumed by Cordis before `apply` runs. */
export const Config: StandardSchemaV1<Config> = createConfigSchema()

/** Hard dependency on the DSH tool registry service. */
export const inject: string[] = ["tools"]

/** Fallback used by smoke hosts that do not expose `ctx.logger`. */
const consoleLogger: HostLogger = {
  info: (...args) => console.log("[orca-pod]", ...args),
  warn: (...args) => console.warn("[orca-pod]", ...args),
  error: (...args) => console.error("[orca-pod]", ...args),
}

/**
 * Start the pod and expose its tools to DSH.
 *
 * Startup is asynchronous and never throws into the host: a failed orca node start
 * is logged and surfaced through the tools (they report "orca node is not
 * running"), while `apply` returns immediately.
 */
export function apply(ctx: HostContext, config: Config): void {
  const logger = ctx.logger ?? consoleLogger
  const handle = startPod(config, logger)

  // Background task tracker: polls tasks dispatched by this session and returns
  // their terminal state to the dispatching agent (notify: auto).
  const tracker = createTracker(() => handle.runtime.orcaNode, { logger })

  // Cordis runs the returned disposer when the plugin fiber unloads (DSH exit,
  // reload, or the bundle being disabled). It awaits the orca node shutdown.
  ctx.effect(
    () => async () => {
      tracker.stop()
      await stopPod(handle, logger)
    },
    "orca-pod.orca-node",
  )

  for (const tool of createPodTools(handle, tracker)) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      logger.error(`orca-pod: failed to register tool ${tool.name}: ${errorMessage(error)}`)
    }
  }
}
