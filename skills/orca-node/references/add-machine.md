# Adding a machine to the mesh

A machine joins the mesh by running DeepSeek Harness with this plugin; there is
no separate installer or service.

1. On the new machine, install DeepSeek Harness, then install this plugin in
   all three profiles, whichever app the machine uses:
   `dsh plugin --profile desktop add orca-pod`,
   `dsh plugin --profile web add orca-pod` and
   `dsh plugin --profile acp add orca-pod`. The `desktop` or `web` copy runs the
   node that other machines call (one node per machine, whichever DSH starts
   first); the `acp` profile runs task children and gives their agent the
   `orca_pod` file methods. Without the `acp` copy tasks still run, but they
   cannot exchange files.
2. Open the Orca Pod panel there and enter the **workgroup id** and **password**
   (the same as the other machines), then pick the interface to listen on and,
   if the machine is reached through a different address than it listens on, the
   address to advertise.
3. From a session on a machine that is already in the mesh, call the `orca_pod`
   tool with `method: "connect"` and `peer: "<new-machine-ip>"` (or the other way
   round: enter this machine's address in the new machine's panel). Check that it
   shows up with `method: "members"`, and finish with a small `send` round trip.

The password is the join credential (same group = same password); the peer list
is what starts the mesh, and members must be mutually reachable (same LAN, a VPN
such as Tailscale/ZeroTier/WireGuard, or public IPv6 with inbound 11811 open).
A machine behind NAT, such as one on a home connection next to a cloud server, can
only dispatch: the server cannot reach it, its panel marks it "network blocked",
and it cannot be handed tasks. Recommend a VPN or public IPv6 for that case.
A machine runs one node however many DSH profiles it has. Do not change a remote
config over the mesh. Traffic is not encrypted: prefer a VPN, and on public IPv6
make sure the workgroup password is strong and each machine has a local
permission ceiling.
