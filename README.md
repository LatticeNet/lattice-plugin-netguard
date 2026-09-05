# lattice-plugin-netguard

Official LatticeNet nftables firewall plugin. It gives a Lattice operator one
place to declare what a fleet node's firewall should be, and to see what that
machine reports it actually has. This repository owns its signed Bundle v2
manifest, Linux runtime, sandbox UI, deterministic packer, and tests. The
released version is the one in `manifest.json`.

The plugin adds a single Extensions entry to the Lattice console, rendered as a
sandboxed iframe. Deactivation removes the navigation entry and the iframe: the
base Dashboard has no NetGuard page of its own.

## Operator surface

One entry, four lenses, and a proof line under the title that says when the
fleet was observed (`observed 03:52:10Z, 41s ago · 33 nodes report`), with the
counts (nodes, managed, observe only, drift, stale) on a stat strip beneath it.
A tile whose read failed says "unknown" rather than the zero an empty join
would print. The toolbar keeps one shape on every lens: the lens tabs, one
search field that narrows whichever lens is open, the match or permission
note, and one primary action (New group on Exposure, Attention and Groups,
New zone on Zones).

The page renders on the shared plugin chassis, `@latticenet/plugin-bridge/chassis`:
the same header, stat strip, toolbar, table card, folding rows, chips and
overlays as the other plugin frames, on the token contract the console
publishes. `ui/src/styles.css` adds only what NetGuard alone needs (the port
list in the exposure cell, the in-place node detail, the findings list, the
rule rows under a group, the editor forms). Until the chassis ships from the
package registry, `ui/package.json` points at the chassis branch build packed
into `ui/vendor/latticenet-plugin-bridge-0.1.0-alpha.2.tgz` (bridge `2b8f45e`,
which lets the sticky table header pin to the frame and wraps the lens strip
below 620px so the Zones tab stays visible at 375); swap it back to the
registry version once `0.1.0-alpha.2` is published.

- **Exposure:** one row per node answering the first question an operator
  has: what is open to the internet right now. The column is computed from the
  node's reported listeners on non-loopback binds, minus what a bound group
  rule or trusted zone confines; a port nothing explains is red and opens its
  row on the Attention lens. MANAGED BY names the bound groups, a
  legacy baseline, or nothing; DRIFT and SEEN carry the drift verdict and the
  snapshot age. A port the node's SSH knock table gates is confined, not
  open: it prints as a "gated" chip under the port list. Opening a row folds
  the node's detail in place beneath it: its unexplained ports, drift hashes,
  listening sockets, interfaces, foreign nftables tables, and the ruleset its
  intent compiles to, with the per-node review and apply flow. More than one
  row can be open, and `?expand=<node_id>` opens one by URL. The row order is
  settled when the list paints and again when every snapshot has landed, so
  the rows hold still while the per-node reads stream in.
- **Attention:** the open ports nothing explains, one row each, with the
  count on the tab. A row expands into the suggestion the server's review
  produces, with "Add to group" (the group editor pre-filled with the
  proposed rule) and "Ignore" (session-local, never saved, undoable from the
  row). The lens says why it is empty: reality not readable, snapshots still
  reading, no match, or nothing unexplained.
- **Groups:** ordered ingress and egress allow or deny rules over protocols,
  inclusive port ranges, and any/zone/CIDR/node/group/domain remotes, each
  rule read back as a sentence ("allows TCP 22 from 10.7.0.0/24"), with how
  many nodes bind the group; the rules fold under the group's row. A group is
  attached to nodes through a binding.
- **Zones:** interfaces and CIDRs accepted before any security group is
  evaluated, with how many nodes trust each. This is how a management path
  stays open.

A node that has never reported is never rendered as healthy, and an empty
listener list is never rendered as "nothing open" unless a fresh snapshot says
so. Counts that the control plane does not have read as "not reported", never
as zero. The page holds no timer: every age is measured from the fetch the
proof line names, and Refresh observes again.

The exposure classification mirrors `lattice-server/internal/netguard/suggest.go`
with two stated differences: a private CIDR remote scopes a rule rather than
opening the port, and an uncovered listener on a managed node whose live table
matches the applied one is closed by the default policy, not exposed.

### Dev harness

`ui/dev.html` runs the real plugin build inside a real iframe against a
stand-in host that speaks the bridge protocol and the production frame model
(the frame is a viewport; `lattice.plugin.resize` is accepted and ignored).

```sh
cd ui
npm ci
npm run dev
# http://localhost:5183/dev.html?scenario=fleet&width=1440
# scenario=fleet|empty|readonly|failing  width=1440|1024|375  theme=dark|light
# frame=<pane height>  zoom=<factor>  latency=<ms, holds every answer to look at the skeleton>
# plugin=lens%3Dgroups or plugin=expand%3Dmetix-dmit-2 (forwarded to the plugin)
```

## Safety boundary

`lattice-server` remains the authority for validation, compilation, linting,
approvals, rollback watchdogs, self-checks, audit, and agent tasks. The plugin's
service `latticenet.netguard/firewall` routes to those operations only after the
gateway verifies plugin and service ownership and method scopes.

- Read (`overview`, `review`, `reality`): `netguard:read`
- Group, zone, binding and adoption writes: `netguard:admin`
- Plan: `netguard:admin` and `network:plan`
- Apply: never issued from the iframe. Planning files an approval, and only an
  approved apply reaches a node.
- Restricted node allowlists: global NetGuard plugin surfaces fail closed.

Legacy baselines stay observe-only until an operator explicitly adopts them. A
plan whose lint findings include a management lockout stays blocked until the
operator accepts that risk against their own account, which is audited.

## Verification

```sh
go test -race ./system-go/...
go test -race ./tools/pluginpack/...
cd ui
npm ci
npm test
npm run typecheck
npm run build
npm run verify:build
```

Build and sign with Go `1.26.4`, Node `22`, the deterministic plugin packer, and
the trusted LatticeNet Ed25519 publisher seed. Never commit the seed.
