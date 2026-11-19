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

import { resolve } from "node:path";

import type { Context, Inject } from "@deepseek-ai/cordis";
import { z } from "zod";
import type {} from "@deepseek-ai/dsh-app-boot";
import { DSH_HOME_ENV, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
// `ctx.settings` is this plugin's own injection; the service package owns the type.
import type {} from "@deepseek-ai/dsh-settings";

import { ModelCatalogFeed } from "./catalog.ts";
import { Pod } from "./pod.ts";
import { OptionalService } from "./services.ts";
import { skillRegistration } from "./skill.ts";
import { LocalNode, PodTool } from "./tools.ts";

import { Tracker } from "./tracker.ts";
import { PanelRoutes } from "./panel-routes.ts";
import { IN_TASK_ENV } from "../executor/acp/executor.ts";

/**
 * Configuration of the `orca-pod` DSH plugin: only what does not belong to the
 * node. The node's settings are one file for the whole machine, written by the
 * panel (`settings-file.ts`), because a profile's plugin config cannot be shared
 * by every profile (§3.9); the password is a DSH credential (§3.6).
 *
 * Cordis validates it with the schema's Standard Schema interface before `apply`
 * runs. Keys it does not know are dropped, so an older profile patch that still
 * carries node settings loads; the panel asks for them again.
 */
export const Config = z.preprocess(
  (input) => input ?? {},
  z.object({
    /** Register the bundled `orca-node` skill with the host's skills service; on unless turned off. */
    skill_injection: z
      .boolean("must be true or false")
      .nullish()
      .transform((value) => value ?? true),
  }),
);
export type Config = z.output<typeof Config>;

/**
 * Hard dependencies: the tool registry, and the credential store that holds the
 * workgroup password and the node's private key. Both are part of the DSH base
 * composition.
 */
export const inject: Inject<Context> = ["tools", "credentials"];

/**
 * Compose the plugin in three steps: build what the pod is made of (touching
 * nothing in the host but its optional services), hook it into the host, and
 * start it.
 *
 * Startup is asynchronous and never throws into the host: a failed orca node start
 * is logged and surfaced through the tools (they report "orca node is not
 * running"), while `apply` returns immediately.
 *
 * A session the task executor spawned loads this plugin too, since tasks run in
 * the host's profile (D46). There it starts no node and offers `orca_pod` with
 * the file methods only, which go through this machine's node (§5.6, §7.9).
 */
export function apply(ctx: Context, config: Config): void {
  const sandbox = new OptionalService(ctx, "sandboxPolicy", "orca-pod.sandbox-policy");
  // A session the task executor spawned (see `IN_TASK_ENV`).
  if (process.env[IN_TASK_ENV] === "1") {
    const local = LocalNode.fromEnv();
    // A node that named none has nothing to offer the task.
    if (local !== null) ctx.tools.register(new PodTool({ kind: "task", local }, sandbox).definition());
    return;
  }

  // Build. One node per machine (§3.9): its data lives in `orca-pod` under the DSH
  // home the host resolved (`$DSH_HOME`, default `~/.dsh`), read the way DSH tells
  // host plugins to (the launcher's snapshot, `.env` layers included), whichever
  // profile this plugin was loaded from. There is no fallback to an earlier location.
  const logger = ctx.logger("orca-pod");
  const launch = launchEnvironmentOf(ctx);
  const dshHome = resolveDshHome(ctx.dshHomePath?.(), { [DSH_HOME_ENV]: launch.get(DSH_HOME_ENV)?.value });
  const feed = new ModelCatalogFeed(ctx, logger);
  // Tasks run in the profile this plugin was loaded from, present only when dsh launched it (D46).
  const pod = new Pod(logger, ctx, feed, resolve(dshHome, "orca-pod"), ctx.profileContext?.name);
  const agents = new OptionalService(ctx, "agents", "orca-pod.agents");
  // The tracker polls whatever the dispatch log holds; the host's sessions only
  // decide who hears about a task when it ends.
  const tracker = new Tracker(pod, logger, (id) => agents.current()?.get(id));

  // Hook in, in the order the host unloads and uses it. Cordis runs the returned
  // disposer when the plugin fiber unloads (DSH exit, reload, or the bundle being
  // disabled); it awaits the orca node shutdown.
  ctx.effect(
    () => async () => {
      tracker.stop();
      await pod.stop();
    },
    "orca-pod.orca-node",
  );
  // A new user message gives the agent a fresh budget of tracker wake-ups.
  ctx.on("agent/inbox/claimed", ({ agent, message }) => {
    if (message.source?.kind === "user") tracker.resetWakes(agent.id);
  });
  // Another DSH process, the settings page or an edit of the credential file may change the
  // password or the node key: the pod restarts once to use it.
  ctx.on("credentials/reference-updated", (ref) => pod.credentialsChanged(ref));
  ctx.on("credentials/record-updated", (key) => pod.credentialsChanged(key));
  // The tool is only visible once the workgroup credentials exist: before that
  // every call would fail with "not configured" and clutter the tool list.
  ctx.tools.register(new PodTool({ kind: "host", pod }, sandbox).definition(), { when: () => pod.configured });
  new PanelRoutes(pod, tracker, feed).register(ctx);
  // The skill ships inside the package and is registered in memory; no copy is
  // written to a user skill root. A task session never registers it: the task
  // preamble tells that agent what it needs.
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

  // Start: boot the pod in the background, the host is not kept waiting. The tracker
  // polls from now on: its rounds read nothing until a node runs, then follow every
  // dispatch the log holds as not ended, restart or not.
  pod.start();
  tracker.start();
}
