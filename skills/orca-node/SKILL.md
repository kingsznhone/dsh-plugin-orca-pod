---

name: orca-node
description: Delegate work to other orca nodes in this mesh, add a machine to the mesh, check tasks you already dispatched, and escalate a blocked sub-task to its origin.
whenToUse: When the user asks you to run something on another machine or orca node, wants to add a machine to the mesh, needs the status or result of a task you dispatched earlier, or when waiting on a sub-task returns exit code 3.
---

# Orca node CLI

This machine runs an orca node. `orca-node` talks to it over loopback, signs as
this orca node, and does **not** listen on a port or start a second process. Use
it whenever a task has to leave this machine.

Sessions spawned by the Orca Pod bundle (ACP executor) export
`ORCA_POD_CLI` (path to the CLI entry) and `ORCA_POD_DATA_ROOT` in their
environment. Prefer them; the examples below use that form:

```bash
node "$ORCA_POD_CLI" --data-root "$ORCA_POD_DATA_ROOT" members --json
#   known peers: id, endpoints, state
node "$ORCA_POD_CLI" --data-root "$ORCA_POD_DATA_ROOT" send --peer <host:port> --text -
#   dispatch a task; text from stdin
#   add --model <provider/model> to pick a model the target advertises (§6.15);
#   add --reasoning-effort <off|low|high|max> to override its local default effort.
node "$ORCA_POD_CLI" --data-root "$ORCA_POD_DATA_ROOT" wait --peer <host:port> --task <id> --local-task <this task> --timeout 120 --json
node "$ORCA_POD_CLI" --data-root "$ORCA_POD_DATA_ROOT" status --peer <host:port> --task <id> --json
node "$ORCA_POD_CLI" --data-root "$ORCA_POD_DATA_ROOT" escalate --peer <child:port> --task <child task> --local-task <this task> --json
```

When those variables are unset (you are not in a spawned session), drop the
`node "$ORCA_POD_CLI" --data-root "$ORCA_POD_DATA_ROOT"` prefix and use the
package's `orca-node` command instead.

`wait` exit codes: `0` completed, `1` failed or canceled, `2` still
running, `3` the target is waiting for a human decision.

## Rules

- Each peer in `members` carries an ordered `endpoints` list (primary first); pass any one to other commands. A bare `host:port` is accepted.
- Pass `--local-task <this task>` to `wait` so a child permission request is
  escalated to your origin automatically; `wait` keeps going after the decision.
- **Never approve your own escalation.** If `wait` exits `3`, run
  `escalate` and tell the user what is blocked and why.
- A task cannot pause to ask its origin a question; only permission requests
  wait for the origin. When you cannot continue (missing information, a
  decision only the origin can make, a required peer offline), finish **your
  own task as completed** and start the final report with
  `BLOCKED: <reason>`; then list what you finished, the blocked step, and what
  the origin should provide or rerun. For an offline peer, retry the same
  command at most once after a few seconds first. Do not poll for minutes, and
  do not wait on a child task that can no longer continue — it ends with its
  own `BLOCKED:` report.
- Pass `--text -` so the task text travels on stdin (no shell quoting).
- Use `--json` whenever you need exact ids, states, or artifacts.
- A task you dispatch is single-hop: this orca node does not forward it.

## Adding a machine

Read [references/add-machine.md](references/add-machine.md) before installing a
new node; it has the installer command and the networking preconditions.
