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

One entry, three lenses, and a proof line under the title that says when the
fleet was observed and what it counted (`observed 03:52:10Z, 41s ago · 33
nodes · 25 managed · 4 observe only · 2 drift · 2 stale`).

- **Exposure:** one row per node answering the first question an operator
  has: what is open to the internet right now. The column is computed from the
  node's reported listeners on non-loopback binds, minus what a bound group
  rule or trusted zone confines; a port nothing explains is red and expands,
  under the table, into the suggestion the server's review produces, with
  "Add to group" (the group editor pre-filled with the proposed rule) and
  "Ignore" (session-local, never saved). MANAGED BY names the bound groups, a
  legacy baseline, or nothing; DRIFT and SEEN carry the drift verdict and the
  snapshot age. Opening a node shows its drift hashes, listening sockets,
  interfaces, foreign nftables tables, and the ruleset its intent compiles
  to, with the per-node review and apply flow.
- **Groups:** ordered ingress and egress allow or deny rules over protocols,
  inclusive port ranges, and any/zone/CIDR/node/group/domain remotes, each
  rule read back as a sentence ("allows TCP 22 from 10.7.0.0/24"), with how
  many nodes bind the group. A group is attached to nodes through a binding.
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
# frame=<pane height>  zoom=<factor>  plugin=lens%3Dgroups (forwarded to the plugin)
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
