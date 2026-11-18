/**
 * `orca-pod` — DeepSeek Harness host-side bundle for Orca.
 *
 * The bundle creates one pod from the plugin config, starts it without
 * blocking the DSH host, registers the `orca_pod` tool, and stops the pod when
 * the plugin fiber unloads. There are no module-level side effects: everything
 * is created inside `apply`.
 *
 * Optional host services are declared with `ctx.inject`. Each callback runs in
 * its own child scope and may run again when the service is replaced, so every
 * registration made there is tied to that scope's `effect`, never to the plugin's.
 */

import type { Context, Inject, Logger } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-app-boot";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
// `ctx.settings` is this plugin's own injection; the service package owns the type.
import type {} from "@deepseek-ai/dsh-settings";

import { PanelModel } from "./panel.ts";
import { ApprovalBroker } from "./broker.ts";
import { ModelCatalogFeed } from "./catalog.ts";
import { Pod } from "./pod.ts";
import { OptionalService } from "./services.ts";
import { skillRegistration } from "./skill.ts";
import { HostPodStores } from "./stores.ts";
import { PodTool } from "./tools.ts";
import { Tracker } from "./tracker.ts";
import { PanelRoutes } from "./panel-routes.ts";
import { DATA_ROOT_ENV, defaultDataRoot } from "../node/config.ts";
import type { Settings } from "../node/settings.ts";

export { Config } from "./config.ts";

/**
 * Hard dependencies: the tool registry, the credential store that holds the
 * workgroup password, and the config editor the panel saves through. All three
 * are part of the DSH base composition.
 */
export const inject: Inject<Context> = ["tools", "credentials", "configEditor"];

/**
 * Compose the plugin in three steps: build what the pod is made of, hook it
 * into the host, and start it.
 *
 * Startup is asynchronous and never throws into the host: a failed orca node start
 * is logged and surfaced through the tools (they report "orca node is not
 * running"), while `apply` returns immediately.
 */
export function apply(ctx: Context, config: Settings): void {
  const bundle = new PodBundle(ctx, config);
  bundle.attach(ctx);
  bundle.start();
}

/** One plugin fiber: it builds what the pod is made of (touching nothing in the host but its optional services), then hooks it in. */
class PodBundle {
  private readonly logger: Logger;
  private readonly feed: ModelCatalogFeed;
  private readonly pod: Pod;
  private readonly broker: ApprovalBroker;
  private readonly tracker: Tracker;
  private readonly agents: OptionalService<"agents">;
  private readonly tool: PodTool;
  private readonly panel: PanelModel;
  private readonly injectsSkill: boolean;

  constructor(ctx: Context, config: Settings) {
    // Read the environment the way DSH tells host plugins to (the launcher's
    // snapshot, `.env` layers included) and take the DSH home the host resolved.
    // The host does not export DSH_PROFILE_DIR to its own plugins, so the loader
    // baseUrl is the profile hint that keeps two profiles apart.
    this.logger = ctx.logger("orca-pod");
    const launch = launchEnvironmentOf(ctx);
    const env = Object.fromEntries(DATA_ROOT_ENV.map((name) => [name, launch.get(name)?.value]));
    const defaultRoot = defaultDataRoot(env, ctx.baseUrl, ctx.dshHomePath?.());
    this.feed = new ModelCatalogFeed(ctx, this.logger);
    this.pod = new Pod(config, this.logger, new HostPodStores(ctx), this.feed, defaultRoot);
    this.broker = new ApprovalBroker(this.pod);
    this.tracker = new Tracker(this.pod, this.broker, this.logger);
    this.agents = new OptionalService(ctx, "agents", "orca-pod.agents", (service) => {
      if (service !== undefined) void this.pod.settled().then(() => this.restoreRunningSessions());
    });
    this.tool = new PodTool(
      this.pod,
      this.tracker,
      new OptionalService(ctx, "sandboxPolicy", "orca-pod.sandbox-policy"),
    );
    this.panel = new PanelModel(this.pod, this.broker, this.feed);
    this.injectsSkill = config.skill_injection;
  }

  /** Register everything the host calls into, in the order the host unloads and uses it. */
  attach(ctx: Context): void {
    // Cordis runs the returned disposer when the plugin fiber unloads (DSH exit,
    // reload, or the bundle being disabled). It awaits the orca node shutdown.
    ctx.effect(() => () => this.dispose(), "orca-pod.orca-node");

    // Per-agent bookkeeping belongs to the agent's own fiber: the tracker forgets
    // the session when it is disposed, and a session created while the host runs
    // (including one resumed after a restart) picks up its own dispatches.
    ctx.on("agent/created", ({ agent }) => {
      this.onAgentCreated(agent);
    });
    // A new user message gives the agent a fresh budget of tracker wake-ups.
    ctx.on("agent/inbox/claimed", ({ agent, message }) => {
      this.onInboxClaimed(agent, message);
    });

    // The tool is only visible once the workgroup credentials exist: before that
    // every call would fail with "not configured" and clutter the tool list.
    ctx.tools.register(this.tool.definition(), { when: () => this.pod.configured });

    new PanelRoutes(this.panel).register(ctx);

    // The skill ships inside the package and is registered in memory; no copy is
    // written to a user skill root. The ACP executor's `dsh` subprocess cannot see
    // this host's registry; it learns publish/fetch from the task preamble instead.
    if (this.injectsSkill) {
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

  /**
   * Boot the pod in the background; the host is not kept waiting. Sessions the
   * host already runs pick up their dispatches once the node is up.
   */
  start(): void {
    this.pod.start();
    void this.pod.settled().then(() => this.restoreRunningSessions());
  }

  /**
   * Resume tracking from the dispatch log (§8.3) for the sessions `resolveAgent`
   * knows: every one the host already runs (startup, or the agent registry
   * appearing), or just the one that was created. Repeating it is harmless:
   * watched or abandoned tasks are left alone.
   */
  private restore(resolveAgent: (id: SessionId) => Agent | undefined): void {
    const run = this.pod.run;
    if (run === null) return;
    this.tracker.restore(run.node.delegation.log.list(), resolveAgent);
  }

  private restoreRunningSessions(): void {
    this.restore((id) => this.agents.current()?.get(id));
  }

  private onAgentCreated(agent: Agent): void {
    agent.ctx.effect(() => () => this.tracker.forget(agent.id), "orca-pod.track");
    void this.pod.settled().then(() => this.restore((id) => (id === agent.id ? agent : undefined)));
  }

  private onInboxClaimed(agent: Agent, message: { source?: { kind?: string } }): void {
    if (message.source?.kind === "user") this.tracker.resetWakes(agent.id);
  }

  private async dispose(): Promise<void> {
    this.broker.clear();
    this.tracker.stop();
    await this.pod.stop();
  }
}
