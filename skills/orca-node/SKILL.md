---

name: orca-node
description: Delegate work to other orca nodes in this mesh, check tasks you already dispatched, publish files for a task and fetch the ones it names, and add a machine to the mesh.
whenToUse: When the user asks you to run something on another machine or orca node, wants to add a machine to the mesh, needs the status or result of a task you dispatched earlier, or wants to hand a file to another node or fetch one it produced.
---

# The orca_pod tool

This machine runs an orca node inside this DSH. Everything goes through the one
`orca_pod` tool; pick the operation with `method`. Use it whenever a task has to
leave this machine.

| method | arguments | does |
| --- | --- | --- |
| `members` | none | lists this node and its peers: id, endpoints, state, whether busy |
| `send` | `peer`, `text`; optional `permission_mode`, `model`, `reasoning_effort` | dispatches a task and returns its `task_id` at once |
| `status` | `peer`, `task_id` | reads one task: state and result text |
| `cancel` | `peer`, `task_id` | asks the target to stop the task |
| `publish` | `path`; optional `ttl_s` | copies a local file into this node and returns its name `<orca node id>/<sha256>` |
| `fetch` | `ref`, `output` | saves a file any member published, checked against its hash |
| `connect` | `peer` | joins a peer into the mesh |

`peer` is a host or `host:port`, a node's display name, or its node id.
`send` does not wait: when the task ends you are told in a follow-up message.

## Limits

- A request body is capped at 1 MiB, a task result at 32 KiB, and the completion
  notice shows 800 characters. Do not put file contents, base64, or long logs into
  `send`; publish files and name them instead, and read a long result with `status`.

## While a task runs

- Do not poll `status` in a loop, and do not wait with shell loops: the follow-up
  message is the signal. If you need one check, `status` is the way.
- If a peer is offline, retry at most once after a few seconds. The tracker stops
  after five consecutive failures and tells you it gave up.
- `input-required` is not a failure: the human at the origin must approve, and the
  same task continues afterwards. Do not resend it or keep polling it.
- `failed` is this origin's conclusion; the target may still have changed its
  workspace. A target restart reports `node_restart`. Re-send only deliberately.

## Files

Files are not part of a task. They are published on a node and named
`<orca node id>/<sha256>`; a name is all anyone needs to fetch one.

- **Hand a file to a task**: `publish` it (relative paths are read against this
  session's directory) and put the name it returns in the task text. The agent
  on the other side fetches it with the same tool.
- **Take files back**: the task's agent publishes what it hands back and names
  the files in its result. Save one with `method: "fetch"` and `ref` set to that
  name; the session's sandbox must allow writing to `output`.
- **Taking files back needs a writable task**: dispatch it with
  `permission_mode: "workspace-write"`; a `read-only` child cannot save a fetched
  file.
- A published file stays downloadable for 7 days unless `ttl_s` says otherwise
  (`0`: never expires); then its node deletes it.

## Rules

- A task needing a permission this session did not give it asks you for it: the
  human decides in this node's panel or chat card; you cannot approve it.
- Tasks are **single-hop**. The agent running your task cannot dispatch
  further, and inside a task `send` is refused (sessions spawned by the task
  executor carry `ORCA_POD_IN_TASK=1`). Split work across nodes yourself, from here.
- A task that cannot continue ends as completed with a final report starting
  `BLOCKED: <reason>`, listing what it finished and what the origin should
  provide or rerun. Read it and decide the next step; do not resend blindly.
- Every machine loads this plugin in **two** profiles: its host profile (the
  running node) and `acp` (task children; `dsh --profile acp`). A machine
  missing the `acp` copy still runs tasks, but its task agents cannot use
  `orca_pod` to exchange files.
- Address peers by node id when display names may collide; the id is stable, a
  display name is not.
- Do not "repair" the node credential: deleting it creates a new `orca_node_id`,
  and every peer sees a new node.
- Nodes speak self-signed HTTPS only: check reachability with `curl -k` (Windows
  Schannel rejects these certificates outright) or Node; `http://` is read as
  `https://`; the default port is 11811.
- Replacing or upgrading the plugin needs a DSH restart to load the new modules;
  in-flight tasks fail `node_restart` and must be re-dispatched. Run the same
  plugin version on all machines.

## Adding a machine

Read [references/add-machine.md](references/add-machine.md) before adding a new
node; it has the steps and the networking preconditions.
