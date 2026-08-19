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

One entry, three tabs:

- **Fleet:** every node the session can see, with declared intent joined to the
  node's own reported snapshot. The posture bar counts drifted, apply-failed,
  stale, never-reported and in-sync nodes, and each count filters the table.
  Opening a node shows its drift hashes, listening sockets, interfaces, foreign
  nftables tables, and the ruleset its intent compiles to.
- **Security groups:** ordered ingress and egress allow or deny rules over
  protocols, inclusive port ranges, and any/zone/CIDR/node/group/domain remotes.
  A group is attached to nodes through a binding.
- **Trusted zones:** interfaces and CIDRs accepted before any security group is
  evaluated. This is how a management path stays open.

A node that has never reported is never rendered as healthy. Counts that the
control plane does not have read as "not reported", never as zero.

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
