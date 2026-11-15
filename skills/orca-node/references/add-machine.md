# Adding a machine to the mesh

Use the installer instead of inventing a protocol. On a Linux node that already
has Node >= 22 and `dsh`:

```bash
npx orca-pod install --workgroup <group> -p '<password>' \
  --peer http://<this-machine>:11811 --endpoint http://<linux-ip>:11811
loginctl enable-linger $USER   # if the installer reports a user service
```

Then from the desktop session call the `orca_pod` tool with
`method: "connect"` and `peer: "<linux-ip>"`, or run the CLI's `members --json`
first and check whether it is already there (see [../SKILL.md](../SKILL.md) for
the exact command in the current session). Finish with a small `send` round
trip.

Principal: the password is the join credential (same group = same password), the
peer list is what starts the mesh, and members must be mutually reachable (same
LAN or VPN). Do not change a remote config over the mesh and do not expose 11811
to the public internet.
