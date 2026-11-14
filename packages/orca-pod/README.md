# orca-pod — Orca node + DeepSeek Harness bundle

One package that is both the Orca node library and the DSH host bundle. A node
runs in-process, joins the workgroup mesh, executes tasks, and exposes four
non-blocking tools to the agent.

The package is self-contained on purpose: its only runtime dependency is
`fastify`, and every first-party module lives under `src/`. Installing the
bundle into a DSH profile therefore needs nothing from this checkout.

```
packages/orca-pod/
├── package.json          # bundle manifest: dsh.bundle.patch -> cordis.patch.yml
├── cordis.patch.yml      # DSH row: id orca-pod, name 'orca-pod', prototype config
├── README.md
├── src/
│   ├── index.ts          # public entry: createNode + apply/Config/inject
│   ├── protocol.ts       # ids, members digest, task/peer types
│   ├── crypto.ts         # workgroup key, request signing, nonce cache
│   ├── config.ts         # persisted node config
│   ├── storage.ts        # peer store (+ re-exported blob store)
│   ├── blobs.ts          # content-addressed blob store
│   ├── gateway.ts        # HTTP: /health, agent card, /cluster/*, /a2a, /blobs
│   ├── executor.ts       # LocalExecutor contract + EchoExecutor
│   ├── tasks.ts          # single-slot task runner
│   ├── node.ts           # createNode: wires gateway, tasks, membership
│   ├── harness.ts        # in-process multi-node mesh for tests
│   ├── cli.ts            # `orca-node serve --config <path>`
│   └── plugin/           # DSH bundle: Config, apply(ctx, config), tools
└── test/                 # vitest suites (protocol, crypto, mesh, a2a, blobs, plugin)
```

## Install (local checkout)

```bash
dsh plugin --profile desktop add /absolute/path/to/orca-pod/packages/orca-pod

# verify the profile picked up the bundle and its patch row
dsh --profile desktop --dump-config
```

`dsh plugin add` records the package as a `link:` dependency in the profile and
appends it to `dsh.profile.bundles`; DSH then resolves the package name through
the profile's `node_modules` and applies `cordis.patch.yml`. Because the bundle
carries no private dependencies, the checkout's `node_modules` is not needed at
runtime. Use the Plugin Manager (or edit the profile's patch/config) to change
the config afterwards.

## Configuration

| Field                | Required | Default                         | Meaning                                                                 |
| -------------------- | -------- | ------------------------------- | ----------------------------------------------------------------------- |
| `workgroup_id`       | yes      | —                               | Workgroup to join; `[a-z0-9][a-z0-9-]{1,31}`                            |
| `workgroup_password` | yes      | —                               | Shared password; the node key is derived from it (prototype: plaintext) |
| `display_name`       | no       | `orca-<node_id>` from node config | Human-readable node name                                              |
| `port`               | no       | `11811`                         | Local listen port (`0` = OS-assigned)                                   |
| `endpoint`           | no       | `http://<host>:<port>`          | Public endpoint advertised to peers                                     |
| `data_root`          | no       | `$ORCA_POD_HOME` or `~/.orca-pod` | Directory of the persisted `config.json` (node identity)             |
| `peers`              | no       | `[]`                            | Peer endpoint URLs to `join` at startup; failures are logged only       |

The node config (`config.json`) is created on first start and reused while the
`workgroup_id` stays the same, so the node id survives DSH restarts. Changing
the password re-derives the shared key in place.

### Security caveat (prototype)

`workgroup_password` is accepted directly in `cordis.patch.yml` for the Phase-0
prototype. That file is plaintext and may be logged or shared. A production
bundle should read the workgroup password from the DSH credentials service
(`ctx.credentials`) and keep the patch/config free of the secret.

## Tools

All four tools return JSON rendered as text and never wait for remote task
execution; tasks run asynchronously on the remote node.

| Tool          | Arguments                | Result                                                         |
| ------------- | ------------------------ | -------------------------------------------------------------- |
| `pod_send`    | `peer`, `text`, `echo?`  | `{task_id, state, peer}` immediately after the remote accepts   |
| `pod_status`  | `peer`, `task_id`        | Remote `TaskView` plus a `terminal` flag                        |
| `pod_cancel`  | `peer`, `task_id`        | Task view observed at cancel time plus `terminal`               |
| `pod_members` | —                        | `{self, members, members_digest}` with id/name/endpoint/state   |

`peer` accepts an `http(s)://host:port` endpoint or a bare `host:port`. The
optional `echo` argument forwards a deterministic echo script as
`metadata.echo` (useful for tests; the executor's default task already echoes).

## Development

```bash
npm run typecheck   # tsc --noEmit for the package
npm test            # vitest run
```

Notes for maintainers:

- The package exports TypeScript source (`"exports": "./src/index.ts"`) and relies
  on the Node ≥22 type stripping used by the DSH runtime. If a DSH build resolves
  linked bundles with symlink preservation instead of real paths, ship a compiled
  JavaScript entry instead (out of scope for the prototype).
- Keep `src/` dependency direction by review: `gateway.ts` must not import
  `executor.ts` or `harness.ts`; only `node.ts` wires them together.
