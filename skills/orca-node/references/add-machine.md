# Adding a machine to the mesh

A machine joins the mesh by running DeepSeek Harness with this plugin; there is
no separate installer or service.

1. On the new machine, install DeepSeek Harness, then install this plugin in the
   profiles that machine uses:
   - **Desktop app**: install `dsh-plugin-orca-pod` from Settings → Plugins. The
     app owns the desktop profile; `dsh plugin --profile desktop add` cannot
     write it.
   - **Other profiles** (`web`, `headless`, `acp`):
     `dsh plugin --profile <name> add dsh-plugin-orca-pod`.

   Install it in the host profile that runs the node and in `acp`, which runs
   task children and gives their agent the `orca_pod` file methods. Without the
   `acp` copy tasks still run, but they cannot exchange files. A machine runs
   one node however many DSH profiles it has, whichever DSH starts first.
2. Open the Orca Pod panel there and enter the **workgroup id** and **password**
   (the same as the other machines), then pick the interface to listen on and,
   if the machine is reached through a different address than it listens on, the
   address to advertise.
3. Networking: members must be mutually reachable (same LAN, a VPN such as
   Tailscale/ZeroTier/WireGuard, or public IPv6 with inbound 11811 open). The
   default port is 11811. On Windows, avoid `40000–41890`: that is the reserved
   dynamic range, and a listener there fails or is unreachable. Allow inbound
   traffic for the chosen port in the firewall. A machine behind NAT, such as one
   on a home connection next to a cloud server, can only dispatch: the server
   cannot reach it, its panel marks it "network blocked", and it cannot be handed
   tasks. Recommend a VPN or public IPv6 for that case.
4. Acceptance: from a session on a machine already in the mesh, check
   `curl -k https://<new-machine>:11811/health` returns the new node's id (the
   certificate is self-signed, so `-k` is expected). Then call `orca_pod` with
   `method: "connect"` and `peer: "<new-machine-ip>"` (or the other way round:
   enter this machine's address in the new machine's panel), confirm both show
   with `method: "members"`, and finish with a small `send` round trip.
5. Upgrades: after upgrading the plugin, restart DSH on that machine so it loads
   the new modules; in-flight tasks fail `node_restart` and must be re-dispatched.
   Run the same plugin version on all machines.

The password is the join credential (same group = same password); the peer list
is what starts the mesh. Do not change a remote config over the mesh. Traffic is
encrypted (HTTPS, each node's certificate is pinned to its id), but anyone who can
reach the port can try to join: on public IPv6 make sure the workgroup password is
strong and each machine has a local permission ceiling.
