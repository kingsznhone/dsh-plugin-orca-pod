---
name: orca-node
description: Delegate work to other orca nodes in this mesh, add a machine to the mesh, check tasks you already dispatched, and escalate a blocked sub-task to its origin.
whenToUse: When the user asks you to run something on another machine or orca node, wants to add a machine to the mesh, needs the status or result of a task you dispatched earlier, or when waiting on a sub-task returns exit code 3.
---

# Orca node CLI

This machine runs an orca node. `orca-node` talks to it over loopback, signs
as this orca node, and does **not** listen on a port or start a second process.
Use it whenever a task has to leave this machine.

```bash
{{cli}} members --json                     # known peers: id, endpoints, state
{{cli}} send --peer <host:port> --text -   # dispatch a task; text from stdin
#   add --model <provider/model> to pick a model the target advertises (§6.15)
{{cli}} wait --peer <host:port> --task <id> --local-task <this task> --timeout 120 --json
{{cli}} status --peer <host:port> --task <id> --json
{{cli}} escalate --peer <child:port> --task <child task> --local-task <this task> --json
```

`wait` exit codes: `0` completed, `1` failed or canceled, `2` still
running, `3` the target is waiting for a human decision.

## Add a machine to the mesh

Use the installer instead of inventing a protocol. On a Linux node that already
has Node >= 22 and `dsh`:

```bash
npx orca-pod install --workgroup <group> -p '<password>' \
  --peer http://<this-machine>:11811 --endpoint http://<linux-ip>:11811
loginctl enable-linger $USER   # if the installer reports a user service
```

Then from the desktop session call the `orca_pod` tool with
`method: "connect"` and `peer: "<linux-ip>"`, or run
`{{cli}} members --json` first and check whether it is already there. Finish with
a small `send` round trip.

Principal: the password is the join credential (same group = same password), the
peer list is what starts the mesh, and members must be mutually reachable (same
LAN or VPN). Do not change a remote config over the mesh and do not expose 11811
to the public internet.

## Rules

- Each peer in `members` carries an ordered `endpoints` list (primary first); pass any one to other commands. A bare `host:port` is accepted.
- Pass `--local-task <this task>` to `wait` so a child permission request is
  escalated to your origin automatically; `wait` keeps going after the decision.
- **Never approve your own escalation.** If `wait` exits `3`, run
  `escalate` and tell the user what is blocked and why.
- Pass `--text -` so the task text travels on stdin (no shell quoting).
- Use `--json` whenever you need exact ids, states, or artifacts.
- A task you dispatch is single-hop: this orca node does not forward it.
