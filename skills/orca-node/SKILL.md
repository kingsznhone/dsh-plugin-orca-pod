---

name: orca-node
description: Delegate work to other orca nodes in this mesh, check tasks you already dispatched, hand files to a task and take back what it produced, and add a machine to the mesh.
whenToUse: When the user asks you to run something on another machine or orca node, wants to add a machine to the mesh, needs the status or result of a task you dispatched earlier, or wants to hand a file to another node or fetch one it produced.
---

# The orca_pod tool

This machine runs an orca node inside this DSH. Everything goes through the one
`orca_pod` tool; pick the operation with `method`. Use it whenever a task has to
leave this machine.

| method | arguments | does |
| --- | --- | --- |
| `members` | none | lists this node and its peers: id, endpoints, state, whether busy |
| `send` | `peer`, `text`; optional `files`, `permission_mode`, `model`, `reasoning_effort` | dispatches a task and returns its `task_id` at once |
| `status` | `peer`, `task_id` | reads one task: state, result text, artifacts |
| `cancel` | `peer`, `task_id` | asks the target to stop the task |
| `fetch` | `ref`, `output` | saves a file a task handed back (an artifact), checked against its hash |
| `connect` | `peer` | joins a peer into the mesh |

`peer` is a host or `host:port`, a node's display name, or its node id.
`send` does not wait: when the task ends you are told in a follow-up message, so
do not poll `status` in a loop.

## Files

- **Hand files to a task** with `files` on `send`: each entry is a local path
  (relative paths are read against this session's directory) or a file a member
  published, written `<orca node id>/<sha256>`. They are placed in the task's
  `inbox/<task id>/` directory before its agent starts. If one cannot be fetched
  the task fails as `input_unavailable` and nothing runs.
- **Take files back**: whatever the task leaves in its `outbox/<task id>/` comes
  back as `artifacts`, named `<orca node id>/<sha256>`. Save one with
  `method: "fetch"` and `ref` set to that name; the session's sandbox must allow
  writing to `output`.

## Rules

- A task needing a permission this session did not give it asks you for it: the
  human decides in this node's panel or chat card; you cannot approve it.
- Tasks are **single-hop**. The agent running your task cannot dispatch
  further, and inside a task `send` is refused (sessions spawned by the task
  executor carry `ORCA_POD_IN_TASK=1`). Split work across nodes yourself, from here.
- A task that cannot continue ends as completed with a final report starting
  `BLOCKED: <reason>`, listing what it finished and what the origin should
  provide or rerun. Read it and decide the next step; do not resend blindly.
- For an offline peer, retry at most once after a few seconds. Do not poll for minutes.

## Adding a machine

Read [references/add-machine.md](references/add-machine.md) before adding a new
node; it has the steps and the networking preconditions.
