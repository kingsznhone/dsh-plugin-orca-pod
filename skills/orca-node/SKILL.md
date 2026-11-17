---

name: orca-node
description: Delegate work to other orca nodes in this mesh, add a machine to the mesh, check tasks you already dispatched, and share files with members.
whenToUse: When the user asks you to run something on another machine or orca node, wants to add a machine to the mesh, needs the status or result of a task you dispatched earlier, or wants to hand a file to another node.
---

# Orca node CLI

This machine runs an orca node. `orca-node` talks to it over loopback, signs as
this orca node, and does **not** listen on a port or start a second process. Use
it whenever a task has to leave this machine.

```bash
orca-node members --json
#   known peers: id, endpoints, state
orca-node send --peer <host:port> --text -
#   dispatch a task; text from stdin
#   add --model <provider/model> to pick a model the target advertises (§6.15);
#   add --reasoning-effort <off|low|high|max> to override its local default effort.
orca-node status --peer <host:port> --task <id> --json
orca-node wait --peer <host:port> --task <id> --timeout 120 --json
orca-node publish <path> --json
#   prints <orca node id>/<sha256>; put that name in the task text you send
orca-node fetch <orca node id>/<sha256> --output <file> --json
```

`wait` exit codes: `0` completed, `1` failed or canceled, `2` still
running, `3` the target is waiting for a permission decision. That decision is
made by the human in this node's UI; you cannot approve it.

## Rules

- Each peer in `members` carries an ordered `endpoints` list (primary first); pass any one to other commands. A bare `host:port` is accepted.
- Tasks are **single-hop**. The agent running your task cannot dispatch
  further, and inside a task this CLI refuses `send` (sessions spawned by the
  task executor carry `ORCA_POD_IN_TASK=1`). Split work across nodes yourself,
  from here.
- A task that cannot continue ends as completed with a final report starting
  `BLOCKED: <reason>`, listing what it finished and what the origin should
  provide or rerun. Read it and decide the next step; do not resend blindly.
- For an offline peer, retry the same command at most once after a few
  seconds. Do not poll for minutes.
- Pass `--text -` so the task text travels on stdin (no shell quoting).
- Use `--json` whenever you need exact ids, states, or artifacts.

## Adding a machine

Read [references/add-machine.md](references/add-machine.md) before installing a
new node; it has the installer command and the networking preconditions.
