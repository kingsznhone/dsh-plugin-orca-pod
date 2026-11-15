/**
 * `orca-pod` — DeepSeek Harness host-side bundle for Orca.
 *
 * The bundle creates one Orca node from the plugin config, starts it without
 * blocking the DSH host, registers the `orca_pod` tool, and stops the orca node when
 * the plugin fiber unloads. There are no module-level side effects: the orca node is
 * only created inside `apply`.
 */


import { createPodAdmin } from "./admin.ts"
import { createApprovalPrompts } from "./prompts.ts"
import { createConfigSchema } from "./config.ts"
import type { Config as PodConfig } from "./config.ts"
import type { HostContext, HostLogger, StandardSchemaV1 } from "./dsh.ts"
import { startPod, stopPod } from "./lifecycle.ts"
import { discoverModelCatalog, type ModelCatalog } from "./models.ts"
import { installSkill } from "./skill.ts"
import { createPodTools } from "./tools.ts"
import { createTracker } from "./tracker.ts"
import { errorMessage } from "./util.ts"
import { registerPodWeb } from "./web.ts"

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
 * Read a service that may be absent without declaring it in `inject`.
 *
 * Cordis throws when a plugin reads a service property it did not inject, so
 * optional services (approval) are fetched through `ctx.get`/a guarded read
 * instead of `ctx.approval`.
 */
function optionalService<T>(ctx: HostContext, name: string): T | undefined {
  const getter = ctx.get
  if (typeof getter === "function") {
    try {
      return getter.call(ctx, name) as T | undefined
    } catch {
      return undefined
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
  } catch {
    return undefined
  }
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

  // Model catalog (§6.15): the host owns the real catalog, the node only
  // advertises it. Kept in a mutable holder so a panel reconfigure restarts the
  // node with the same catalog before the first join.
  const catalog: ModelCatalog = { models: [], defaultModel: null }
  const handle = startPod(config, logger, {
    onNodeStarted: (orcaNode) => orcaNode.setModelCatalog(catalog.models, catalog.defaultModel),
  })
  void handle.ready.then(async () => {
    try {
      const next = await discoverModelCatalog(ctx, logger)
      catalog.models = next.models
      catalog.defaultModel = next.defaultModel
      const orcaNode = handle.runtime.orcaNode
      if (orcaNode !== null) orcaNode.setModelCatalog(catalog.models, catalog.defaultModel)
      if (catalog.models.length > 0) {
        logger.info(`orca-pod: advertising ${catalog.models.length} models`)
      }
    } catch (error) {
      logger.warn(`orca-pod: could not discover the model catalog: ${errorMessage(error)}`)
    }
  })

  // Parked `orca_pod` approve calls: the panel, chat card and popup answer them.
  const prompts = createApprovalPrompts()

  // Background task tracker: polls tasks dispatched by this session and returns
  // their terminal state to the dispatching agent. A permission request that is
  // already parked in the prompt registry is answered by the UI card, so the
  // tracker records it without injecting a redundant chat notice.
  const tracker = createTracker(() => handle.runtime.orcaNode, {
    logger,
    isPromptParked: (peer, taskId) =>
      prompts.list().some((prompt) => prompt.peer === peer && prompt.task_id === taskId),
    onPermission: ({ peer, taskId, request, view, agentId }) => {
      const orcaNode = handle.runtime.orcaNode
      if (orcaNode === null) return false
      // Park the approval in the UI directly: the user answers the card and the
      // decision is sent to the remote task, so no raw request text is injected
      // into the agent conversation.
      prompts.park({
        peer,
        task_id: taskId,
        request,
        agent_id: agentId,
        onDecision: (decision) =>
          decision === "allow"
            ? orcaNode.approveTask(peer, view)
            : orcaNode.denyTask(peer, view, "denied in the Orca Pod UI"),
      })
      return true
    },
    onSettled: (peer, taskId) => {
      prompts.withdraw(peer, taskId)
    },
  })

  // ACP and CLI executors run in their own `dsh` subprocesses and cannot see
  // this host's tools; they get ORCA_POD_CLI/ORCA_POD_DATA_ROOT in their
  // environment instead. The skill bundle also ships in the package, so a
  // user-root copy is optional (off by default) and install is idempotent.
  if (config.skill_injection) {
    void installSkill().then(
      (installed) => {
        if (installed.written) logger.info(`orca-pod: installed skill at ${installed.path}`)
      },
      (error) => logger.warn(`orca-pod: could not install skill: ${errorMessage(error)}`),
    )
  }

  // Cordis runs the returned disposer when the plugin fiber unloads (DSH exit,
  // reload, or the bundle being disabled). It awaits the orca node shutdown.
  ctx.effect(
    () => async () => {
      prompts.cancelAll()
      tracker.stop()
      await stopPod(handle, logger)
    },
    "orca-pod.orca-node",
  )

  // Settings-page panel: members, local tasks, approvals and workspace browsing.
  // The route is same-origin and loopback-gated; hosts without a web UI skip it.
  const admin = createPodAdmin(handle, tracker, { prompts })
  registerPodWeb(ctx, admin, logger)

  for (const tool of createPodTools(handle, tracker, {
    approval: optionalService(ctx, "approval"),
    prompts,
  })) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      logger.error(`orca-pod: failed to register tool ${tool.name}: ${errorMessage(error)}`)
    }
  }
}
