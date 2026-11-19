import { isWildcardHost } from "@deepseek-ai/dsh-host-webserver";
import { randomBytes } from "node:crypto";
import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";
import { join } from "node:path";

import { Gateway } from "../api/gateway.ts";
import { FileBlobRegistry } from "../core/blobs.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_RESULT_MAX_BYTES, DEFAULT_TASK_TIMEOUT_S } from "../core/constants.ts";
import { NODE_TOKEN_ENV, NODE_URL_ENV } from "../core/entry.ts";
import { EventBus, type NodeLogger } from "../core/events.ts";
import { shortenNodeId, type NodeIdentity } from "../core/identity.ts";
import { ModelCatalog } from "../core/model-catalog.ts";
import { bindUrl, detectLocalEndpoints } from "../core/net.ts";
import { SqliteDb, storeDbPath } from "../core/sqlite.ts";
import type { OrcaNodeId, RuntimeInfo, WorkgroupId } from "../core/wire/peer.ts";
import { AcpExecutor } from "../executor/acp/executor.ts";
import { EchoExecutor } from "../executor/echo.ts";
import type { LocalExecutor } from "../executor/executor.ts";
import { MeshContext } from "../mesh/context.ts";
import { Mesh } from "../mesh/mesh.ts";
import { HttpPeerClient, type FetchLike } from "../mesh/peer-client.ts";
import { EndpointScreen } from "../mesh/screening.ts";
import { resolveClock, type MeshClock, type MeshTimings } from "../mesh/timings.ts";
import type { MembersEvent, SelfDescription } from "../mesh/wire.ts";
import { DispatchLog } from "../task/dispatch-log.ts";
import { SingleSlotTaskRunner } from "../task/runner.ts";
import type { DispatchEvent, TaskEvent } from "../task/wire.ts";
import { Workspace } from "../task/workspace.ts";
import type { Settings } from "./settings.ts";

/** What an orca node tells an in-process listener (the UI panel) it may want to re-render (§9.2). */
export type PodEventInput = TaskEvent | MembersEvent | DispatchEvent;

type OrcaNodeOptions = {
  runtime?: RuntimeInfo;
  timings?: Partial<MeshTimings>;
  clock?: Partial<MeshClock>;
  /** Outbound HTTP for peer calls; tests inject packet loss / delay / partitions. */
  fetch?: FetchLike;
  /** Executor override; defaults to `settings.executor` (echo when unset). */
  executor?: LocalExecutor;
  /** The DSH profile the ACP executor runs tasks in: the host's own (D46). Unset passes none. */
  profile?: string;
  /** Where refusals and drops are reported; silent unless the entry point supplies one. */
  logger?: NodeLogger;
};

const SILENT: NodeLogger = { warn() {} };

/**
 * The orca instance of this process: the one place that builds the subsystems,
 * wires them to each other and publishes them as read-only fields. The mesh is
 * the way in to every node, this one included (`orca.mesh.self`,
 * `orca.mesh.resolve(ref).sendTask(…)`); the instance itself keeps only what
 * spans them.
 *
 * Building one is cheap and quiet: nothing touches the disk or the network
 * until `start()`.
 */
export class Orca {
  /** Everything a UI panel may re-render: task, member and dispatch changes of all subsystems (§9.2). */
  readonly events: EventBus<PodEventInput>;
  /** The model routes this node offers and the default a task gets (§6.15). */
  readonly models: ModelCatalog;
  /** The node table; this node is a row of it. */
  readonly mesh: Mesh;
  /** What this node handed to other nodes, and what it last heard of each task (§8.3). */
  readonly dispatches: DispatchLog;
  /** Tasks this node runs for others. */
  readonly tasks: SingleSlotTaskRunner;
  /** Workspace directories, for UI browsing. */
  readonly workspace: Workspace;
  /** The files this node published (§5.6): the `orca_pod` tool publishes into it, members fetch from the gateway. */
  readonly blobs: FileBlobRegistry;

  private readonly executor: LocalExecutor;

  /** What this machine's processes (a task session) show the local routes; it lives as long as this instance (§5.6). */
  private readonly localToken = randomBytes(32).toString("base64url");
  /** Where a process on this machine dials this node; known once it listens. */
  private localUrl: string | null = null;
  /** The per-task budget peers see as `max_task_ttl_s`, and the hard cap the task runner enforces (§6.9). */
  private readonly taskTimeoutS: number;
  /** The one database of the data root (§5.5): tasks, published files and dispatches; `start()` opens it. */
  private readonly db: SqliteDb;
  private readonly gateway: Gateway;
  private readonly runtime: RuntimeInfo;
  private readonly workgroupId: WorkgroupId;

  constructor(
    /** What the node runs with; the settings must name a workgroup. */
    readonly settings: Settings,
    /** Who this node is: its private key signs every request (§7.1). */
    readonly identity: NodeIdentity,
    /** The workgroup key, derived from the password; it lives in memory only (§7.1). */
    key: Buffer,
    /** Where the node keeps its database, workspaces and published files (§3.9). */
    dataRoot: string,
    options: OrcaNodeOptions = {},
  ) {
    if (settings.workgroup_id === undefined) throw new Error("workgroup_id is required");
    this.workgroupId = settings.workgroup_id;
    const logger = options.logger ?? SILENT;
    this.events = new EventBus(logger);
    this.db = new SqliteDb(storeDbPath(dataRoot));
    this.blobs = new FileBlobRegistry(this.db, join(dataRoot, "blobs"));
    this.workspace = new Workspace(dataRoot, this.workgroupId);
    this.runtime = options.runtime ?? Orca.collectRuntime();
    this.taskTimeoutS = settings.task_timeout_s ?? DEFAULT_TASK_TIMEOUT_S;

    this.models = new ModelCatalog(settings, logger);
    this.dispatches = new DispatchLog(this.db, logger);
    const context = new MeshContext(
      identity,
      this.workgroupId,
      new HttpPeerClient(identity, key, this.workgroupId, {
        fetch: options.fetch ?? ((url, init) => fetch(url, init)),
        // Every outbound call needs a deadline (§4.7): a peer that accepts the
        // connection and then stalls would otherwise hang a tool call or the tracker.
        timeoutMs: settings.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS,
      }),
      this.dispatches,
      this.blobs,
      new EndpointScreen({
        allowPublicPeers: settings.allow_public_peers,
        allowLoopbackPeers: settings.allow_loopback_peers,
      }),
      resolveClock(options.clock),
      logger,
    );
    this.mesh = new Mesh(context, this.describeSelf(Orca.endpointsFrom(settings, settings.port)), {
      timings: options.timings,
    });
    this.executor =
      options.executor ??
      (settings.executor === "acp"
        ? new AcpExecutor(settings.acp ?? {}, this.models, logger, {
            profile: options.profile,
            // The task's plugin reaches this node through its local routes (§5.6).
            env: (): Record<string, string> =>
              this.localUrl === null ? {} : { [NODE_URL_ENV]: this.localUrl, [NODE_TOKEN_ENV]: this.localToken },
          })
        : new EchoExecutor());
    this.tasks = new SingleSlotTaskRunner(this.executor, this.db, this.workspace, {
      logger,
      selfOrcaNodeId: identity.orcaNodeId,
      workgroupId: this.workgroupId,
      permissionCeiling: settings.permission_mode,
      permissionTtlS: settings.approval_timeout_s,
      resultMaxBytes: settings.result_max_bytes ?? DEFAULT_RESULT_MAX_BYTES,
      maxWorkspaceBytes: settings.max_workspace_bytes,
      maxWorkspaceFiles: settings.max_workspace_files,
      taskTimeoutS: this.taskTimeoutS,
    });
    this.gateway = new Gateway(this.mesh, this.tasks, key, identity, { token: this.localToken, blobs: this.blobs });

    // The subsystems tell, the instance decides who needs to know.
    this.tasks.events.subscribe((event) => {
      this.events.emit(event);
      // The busy holder is part of every member record; re-render it too.
      this.mesh.self.setBusy(this.tasks.busy());
      this.mesh.emitMembersIfChanged();
    });
    this.mesh.events.subscribe((event) => this.events.emit(event));
    this.dispatches.events.subscribe((event) => this.events.emit(event));
    // A new catalog changes what this node announces about itself (§6.15).
    this.models.changes.subscribe(() => {
      this.mesh.self.describe(this.describeSelf(this.mesh.self.endpoints));
      this.mesh.emitMembersIfChanged();
    });
  }

  get orcaNodeId(): OrcaNodeId {
    return this.identity.orcaNodeId;
  }

  /**
   * Bind the listener and start the heartbeat; resolves with the URL peers should dial.
   *
   * Binding the port comes first, and nothing that touches the data root happens
   * before it: the port is the lock that keeps a second process on this machine
   * (another DSH with the same plugin) from recovering the tasks and dispatches
   * of the one that is running (§3.9). The database is opened, and the
   * interrupted work failed, in the same turn the bind completes in, so no
   * request can reach a store that is not open.
   */
  async start(): Promise<{ url: string; port: number }> {
    const address = await this.gateway.listen(this.settings.bind_host, this.settings.port);
    this.db.open();
    this.blobs.start();
    this.workspace.ensure();
    this.tasks.start();
    this.dispatches.markInFlightUnknown();
    const port = Number(new URL(address).port);
    this.localUrl = Orca.localUrlOf(this.settings.bind_host, port);
    const urls = Orca.endpointsFrom(this.settings, port);
    this.mesh.self.describe(this.describeSelf(urls));
    this.mesh.start();
    return { url: urls[0], port };
  }

  async stop(): Promise<void> {
    this.blobs.stop();
    this.mesh.stop();
    await this.gateway.close();
    await this.executor.close?.();
    this.db.close();
  }

  /** Where a process on this machine dials a node bound to `host`: loopback for a wildcard bind, else the bound address. */
  private static localUrlOf(host: string, port: number): string {
    return (isWildcardHost(host) ? undefined : bindUrl(host, port)) ?? `http://127.0.0.1:${port}`;
  }

  /** What this node says about itself (§2.5, §3.3): who it is, where it can be dialed, what it runs on, which models it offers. */
  private describeSelf(endpoints: readonly string[]): SelfDescription {
    const offers = this.models.offers();
    const defaults = this.models.defaults();
    return {
      // A fresh node with no display name shows its shortened id (§9.2 wizard default).
      display_name: this.settings.display_name ?? shortenNodeId(this.identity.orcaNodeId),
      endpoints: [...endpoints],
      runtime: this.runtime,
      max_task_ttl_s: this.taskTimeoutS,
      ...(offers.length > 0 ? { models: offers } : {}),
      default_model: defaults.model,
      default_reasoning_effort: defaults.reasoningEffort,
    };
  }

  /** Snapshot of the local runtime, used to advertise what this machine can do. */
  private static collectRuntime(): RuntimeInfo {
    const platform = osPlatform();
    const processors = cpus();
    return {
      os: {
        family: platform,
        name: platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform,
        version: osRelease(),
      },
      arch: process.arch,
      cpu: {
        model: processors[0]?.model ?? "unknown",
        logical_cores: processors.length,
      },
      memory: { total_bytes: totalmem() },
      node: { version: process.version },
      captured_at: new Date().toISOString(),
    };
  }

  /** Addresses a remote orca node should dial: explicit list, else derived from bind. */
  private static endpointsFrom(settings: Settings, port: number): [string, ...string[]] {
    const [first, ...rest] = settings.endpoints;
    if (first !== undefined) return [first, ...rest];
    if (!isWildcardHost(settings.bind_host)) {
      const url = bindUrl(settings.bind_host, port);
      if (url !== undefined) return [url];
    }
    const [firstDetected, ...restDetected] = detectLocalEndpoints(port);
    return firstDetected === undefined ? [`http://127.0.0.1:${port}`] : [firstDetected, ...restDetected];
  }
}
