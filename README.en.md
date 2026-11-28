<div align="center">

<img src="icon-full.webp" width="256" height="256" alt="Orca Pod icon: five small orcas joined pairwise by glowing lines into a fully connected mesh">

# Orca Pod

[![version](https://img.shields.io/github/package-json/v/kingsznhone/dsh-plugin-orca-pod)](https://github.com/kingsznhone/dsh-plugin-orca-pod/blob/main/package.json)
[![npm](https://img.shields.io/npm/v/dsh-plugin-orca-pod)](https://www.npmjs.com/package/dsh-plugin-orca-pod)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-orca-pod)](https://www.npmjs.com/package/dsh-plugin-orca-pod)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/kingsznhone/dsh-plugin-orca-pod)

**Turn the machines you own into one network — distributed, whale-ly**

Windows / Linux / macOS · 2–10 machines · HTTPS end to end

English · [简体中文](README.md)

[Features](#what-it-does) · [Install](#install) · [First setup](#first-setup) · [Everyday use](#everyday-use) · [Settings](#settings) · [FAQ](#faq)

</div>

---

Say one sentence to the agent in DeepSeek Harness on any of your machines, and the task is handed to another one; when it finishes, the result comes back into your conversation by itself.

> 💬 your conversation → 📤 dispatched to office-pc → ⚙️ runs on that machine → 📥 result returns to your conversation

Made for people with 2–10 machines (Windows or Linux) — say, the laptop you use every day plus a faster desktop or a home server.

## What it does

- 🕸️ **Your machines, one mesh**: every machine can see every other one. A new machine only has to reach any single machine already in the mesh; the rest will discover it within moments.
- 📤 **Hand a task to another machine**: just say so in the conversation, e.g. "have office-pc run this repo's tests". The task runs there, under that machine's own DSH. You don't have to stand by: when it finishes, the result appears in the conversation where you dispatched it.
- 📁 **Move files between machines**: when a task needs a file, the agent publishes it and the other side fetches it; files the task produces come back the same way.
- 🛡️ **You stay in control of permissions**: a task inherits the permissions of the conversation that started it. If it needs more, an approval card appears, and the task continues only after you click **Allow upgrade**.
- 🔒 **Everything is encrypted**: all machine-to-machine traffic is HTTPS, with no certificates to apply for or configure. Each machine mints its certificate from its own identity key, and every connection verifies that the peer really is that machine — someone in the middle can neither read the traffic nor impersonate a machine.
- 🚦 **Status at a glance**: a diamond-shaped status light sits at the bottom of the sidebar (see [Status light](#status-light)). Open the panel to see online machines, tasks in flight and pending approvals. A sound plays when an approval arrives or a task completes or fails.

## Before you start

- ✅ DSH 0.2.2-rc.5 or newer on every machine.
- ✅ The machines can reach each other: on the same LAN, on the same VPN, or all with public IPv6 addresses. If you want to connect a home computer to a cloud server, read [Cross-network setup](#cross-network-setup-home-computer--cloud-server) first.
- ✅ Each machine's firewall lets the other machines reach Orca Pod's port (TCP 11811 by default).

## Install

Do this once on every machine.

### 1. Install the plugin

Run these three commands in a terminal; the plugin is downloaded from npm:

```bash
dsh plugin --profile desktop add dsh-plugin-orca-pod
dsh plugin --profile web add dsh-plugin-orca-pod
dsh plugin --profile acp add dsh-plugin-orca-pod
```

Run all three; it doesn't matter whether this machine uses the desktop app or `dsh web`:

| Profile | Used for |
| --- | --- |
| `desktop` | The desktop app |
| `web` | The web UI (`dsh web`) |
| `acp` | The agents that run tasks on this machine, so they can send and receive files |

However many profiles you install it into, a machine still counts as one machine in the mesh, and there is only one set of settings.

### 2. Reopen DeepSeek Harness

An **Orca Pod** button appears at the bottom of the sidebar.

## First setup

### The first machine: create the network

1. Click **Orca Pod** at the bottom of the sidebar. The first launch shows the setup wizard.
2. Enter a **workgroup id**, e.g. `home-lab`. This is the name of the network; lowercase letters, digits and hyphens only.
3. Enter a **workgroup password**. Every machine in the mesh must use the same one, and it cannot be empty.
4. The **listen address** defaults to `127.0.0.1`, which only this machine can reach. To let other machines connect, choose this machine's LAN address, or `::` to listen on all interfaces. Normally leave the port at 11811.
5. Click **Start**.

### Every machine after that: join the network

1. Install the plugin as above, then enter the **same workgroup id and password** in the wizard, and choose a LAN listen address as well.
2. In the panel's **Join a mesh** box, enter the address of any machine already in the mesh (add the port if it isn't 11811) and click **Connect**.

> 💡 **You can also do it the other way round**: open a conversation on a machine that is already in the mesh and say "add 192.168.1.20 to the mesh".

Once connected, **Peers online** in the panel lists the other machines, and the status light in the sidebar turns green.

## Cross-network setup (home computer + cloud server)

Home broadband usually sits behind NAT (the router's address translation): the home computer can dial out, but machines outside can't dial in. If you connect a home computer straight to a cloud server (VPS), only one direction works:

| | Possible? |
| --- | --- |
| The home computer dispatches tasks to the server, checks progress, handles approvals, and fetches files the server sends back | ✅ yes |
| The server dispatches a task to the home computer | ❌ no |
| The home computer hands a file to a task on the server | ❌ no |
| Two computers, each behind a different home broadband, connect to each other | ❌ cannot connect at all |

In the server's panel, the home computer is marked **network blocked**. To let every machine reach every other one, pick one of these two approaches.

### Option 1: VPN mesh (recommended)

Use a tool such as Tailscale, ZeroTier or WireGuard to put all the machines on one virtual LAN, then:

1. Set each machine's **listen address** to the VPN adapter's address, or `::` to listen on all interfaces.
2. Connect to each other using the addresses the VPN assigns.

Every machine can then reach every other one directly, and NAT is no longer in the way.

### Option 2: public IPv6

Many home connections already have a public IPv6 address, so machines outside can connect straight in. This needs:

1. A usable IPv6 address on both the cloud server and the home computer, and the two must be able to ping each other.
2. The home router (or ONT) and the computer's firewall must allow inbound TCP 11811. Many home routers silently drop inbound IPv6 by default, so this usually takes a manual change.
3. Set the **listen address** to `::`, and check that **local node addresses** in Settings include this machine's public IPv6 address.

> ⚠️ **A word of caution about public IPv6**
>
> - This exposes Orca Pod's port directly to the public internet. The traffic itself is encrypted, but anyone can connect to the port and try to join; the workgroup password is the only gate. Use a strong workgroup password, and set a **local permission ceiling** on every machine.
> - A home IPv6 address may change. If it does, update **local node addresses** in Settings; alternatively, point a domain name that always resolves to this machine (DDNS) at it.

## Everyday use

No commands to remember — just talk to the agent in DeepSeek Harness:

```text
which machines are in the mesh right now?
have office-pc run this repo's tests and tell me which ones fail
hand data.csv to build-server and ask it to chart it and send the chart back
how is the task I sent to office-pc doing?
cancel the task I sent to build-server
```

A few things to know:

- **Tasks run in the background**: once dispatched you can carry on with other work; when the task ends, the result appears in the original conversation.
- **How to refer to a machine**: use its **display name** from Settings, or its address. It's worth giving every machine a name you'll recognize.
- **One hop only**: a machine that receives a task will not forward it to a third machine. If work has to be split across several machines, dispatch to each of them from your own conversation.
- **One task at a time per machine**: a busy machine refuses new tasks; the agent tells you so, and you can dispatch again later or use another machine. The member list in the panel shows which machine is busy.

### Status light

| Color | Meaning |
| --- | --- |
| ⚪ Gray | Not connected to any other machine yet |
| 🟢 Green | Connected |
| 🟠 Amber | An approval is waiting for you |

### Approvals

A task starts with the permissions of the conversation that dispatched it — read-only, for example. If it needs more while running, you'll see a card asking for more permission, which may appear in the original conversation, in a background popup, or in the panel:

- Click **Allow upgrade**: the task runs with the higher level until it ends, and you won't be asked again for the same kind of operation.
- Click **Deny**: the task does not get that permission.

Approvals never time out; they wait for you. While one is pending, the sidebar status light turns amber.

## Settings

The panel's **Settings** page is organized into groups. Change what you need and click **Save & restart**; this machine's node restarts with the new settings.

| Group | What you can change |
| --- | --- |
| Workgroup & identity | workgroup id, workgroup password (leave blank to keep the current one), display name |
| Network | listen address, listen port, local node addresses (the address other machines use to reach this one; usually detected automatically) |
| Advanced settings | **task timeout (s)**: how long one task may run, 1 hour by default; **workspace size limit (GiB)**: 5 GiB by default; **local permission ceiling**; **default reasoning effort** |
| Danger zone | Full reset: clears the workgroup settings, the password and this machine's identity, and returns to the first-run wizard; existing task records and files are not affected |

Things to know:

- **One machine, one node**: however many profiles are installed and however many DeepSeek Harness instances are open, this machine counts as one machine in the mesh and has a single set of settings. If two DeepSeek Harness instances run at once, only the one started first runs the node.
- **Changing the password rebuilds the workgroup**: every machine in the mesh has to switch to the new password; machines still using the old one are rejected.

## Security notes

- 🔐 **Encrypted traffic, password-gated membership**: all machine-to-machine traffic is HTTPS-encrypted, so the networks in between see neither task content nor files. But anyone who can reach the port can try to join, so the more exposed the port, the stronger the password must be. For connections across networks, prefer a VPN; if you use public IPv6, set the password and permission ceiling as described in [Cross-network setup](#cross-network-setup-home-computer--cloud-server).
- 🔑 **The workgroup password is the membership credential**: any machine that knows it can join your network and dispatch tasks to your machines. Treat it like any other important password. It is stored in DeepSeek Harness's credential store, not written into a plain file.
- 🧱 **Set a local permission ceiling on machines others may use**: tasks from other machines run on your machine, and their permissions are approved by the dispatching side. With a ceiling in place, no matter what the origin approves, a task on this machine never exceeds it.

## FAQ

### The status light stays gray and I can't reach other machines

- Do both sides use exactly the same workgroup id and password?
- Is the listen address still `127.0.0.1`? If so, change it to a LAN address or `::`.
- Does the firewall allow port 11811?
- Can the two machines reach each other at all — try pinging one from the other.

### A machine shows as "suspect" or "offline"

That means its heartbeats have stopped arriving for a while. Common causes: the machine is asleep or switched off, DeepSeek Harness isn't running, or the network is down. It returns to online by itself once it recovers.

### A machine is marked "network blocked"

This node receives its heartbeats but cannot connect to it, so traffic only flows one way. The most common case is a cloud server looking at a home computer: the home computer is behind NAT, so the server can't dial in. The machine can still dispatch tasks to this one, but this one can't dispatch tasks to it. Put the machines on a VPN or public IPv6 as described in [Cross-network setup](#cross-network-setup-home-computer--cloud-server), or check the firewall and port on that side.

### Tasks run, but files can't be transferred

That machine's `acp` profile probably doesn't have the plugin. Run `dsh plugin --profile acp add dsh-plugin-orca-pod` on it.

### "Node is already running in another DeepSeek Harness process"

Another DeepSeek Harness on this machine is already running the node, and this machine stays online in the mesh as usual. Use Orca Pod from that DeepSeek Harness, or close it and reopen the current one.

## Update and uninstall

### Update to the latest version

Run these three commands, then reopen DeepSeek Harness:

```bash
dsh plugin --profile desktop add dsh-plugin-orca-pod@latest
dsh plugin --profile web add dsh-plugin-orca-pod@latest
dsh plugin --profile acp add dsh-plugin-orca-pod@latest
```

> ⚠️ **Update every machine in the mesh together**: different versions may speak incompatible protocols, and machines left on the old version may not be able to reach the updated ones.

### Uninstall

1. If you also want to clear the password and this machine's identity, click **Full reset** in Settings → Danger zone first.
2. Remove the plugin from all three profiles:

   ```bash
   dsh plugin --profile desktop remove dsh-plugin-orca-pod
   dsh plugin --profile web remove dsh-plugin-orca-pod
   dsh plugin --profile acp remove dsh-plugin-orca-pod
   ```

3. Task records and transferred files are kept in the `orca-pod` folder under DeepSeek Harness's data directory (`~/.dsh/orca-pod` by default); delete it by hand if you no longer need it.

---

🛠️ For development, see [docs/README.md](docs/README.md) (currently in Chinese).

---

## License

Released under **GPL-3.0-only**; see [LICENSE](LICENSE).

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=kingsznhone/dsh-plugin-orca-pod&type=date&legend=top-left)](https://www.star-history.com/?repos=kingsznhone%2Fdsh-plugin-orca-pod&type=date&legend=top-left)
