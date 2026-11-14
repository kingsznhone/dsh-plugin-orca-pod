# @orca/pod — Orca pod bundle for DeepSeek Harness

Host-side DSH bundle that runs one Orca node in-process and exposes it to the
agent through four non-blocking tools. The library root stays in
`@orca/orca-node`; this package is only the DSH installation/composition root
(see `docs/09-implementation.md` §9.4).

```
packages/dsh-plugin/
├── package.json          # bundle manifest: dsh.bundle.patch -> cordis.patch.yml
├── cordis.patch.yml      # DSH row: id orca-pod, name '@orca/pod', prototype config
├── README.md
└── src/
    ├── index.ts          # plugin entry: Config, inject, apply(ctx, config)
    ├── config.ts         # validated config + Standard Schema validator
    ├── dsh.ts            # local structural types for the Cordis/DSH host surface
    ├── node.ts           # non-blocking node start/stop lifecycle
    ├── tools.ts          # pod_send / pod_status / pod_cancel / pod_members
    └── util.ts           # error helpers
```

The bundle imports no `@deepseek-ai/*` runtime packages. Its host contract is a
local structural type (`src/dsh.ts`), and the plugin config is a plain
Standard Schema — Cordis only requires `Config['~standard'].validate`, so no
Schemastery dependency is added for this prototype.

## Install (linked checkout)

The bundle is private to this monorepo and is meant to be linked, not published:

```bash
# from packages/dsh-plugin/ (or pass this absolute path)
dsh plugin --profile desktop add /absolute/path/to/orca-pod/packages/dsh-plugin

# verify the profile picked up the bundle and its patch row
dsh --profile desktop --dump-config
```

`dsh plugin add` records the package as a `link:` dependency in the profile and
appends it to `dsh.profile.bundles`; DSH then resolves `@orca/pod` through the
profile's `node_modules` and applies `cordis.patch.yml`. Because the checkout
keeps its own `node_modules`, the linked bundle resolves `@orca/*` from the
repository root. Use the Plugin Manager (or edit the profile's patch/config) to
change the config afterwards.

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
npm run typecheck   # tsc --noEmit for the whole workspace
npm test            # vitest run
```

Notes for maintainers:

- The bundle exports TypeScript source (`"exports": "./src/index.ts"`) and relies
  on the Node ≥24 type stripping used by the DSH runtime. If a DSH build resolves
  linked bundles with symlink preservation instead of real paths, ship a compiled
  JavaScript entry instead (out of scope for the prototype).
- Adding the workspace dependencies above to `package.json` requires a
  repository-level `npm install` to refresh `package-lock.json`; this change did
  not touch the root lockfile.
