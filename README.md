# lattice-plugin-netguard

Official LatticeNet nftables security-group plugin. This repository owns its
signed Bundle v2 manifest, Linux runtime, sandbox UI, deterministic packer, and
tests. Current prerelease: `v0.1.0-alpha.6`.

## Operator surface

The plugin contributes one Extensions entry with three internal workspaces:

- **Nodes:** authority state, attached groups, trusted zones, drift anchor,
  explicit legacy adoption, and approval-plan creation.
- **Security groups:** ordered ingress/egress allow or deny rules with protocol,
  inclusive port ranges, and any/zone/CIDR/node/group/domain remotes.
- **Trusted zones:** reviewed interface and CIDR trust surfaces, including
  overlay interfaces such as `tailscale0` and `wg0`.

The UI is built and released from this repository. Deactivation removes the
navigation and iframe; the base Dashboard has no NetGuard page implementation.

## Safety boundary

The `lattice-server` core remains the authority for validation, compilation,
linting, approvals, rollback watchdogs, self-checks, audit, and agent tasks. The
plugin's own service `latticenet.netguard/firewall` routes to those exact
operations only after the gateway verifies plugin/service ownership and method
scopes.

- Read: `netguard:read`
- Group/zone/binding/adoption writes: `netguard:admin`
- Plan: `netguard:admin` and `network:plan`
- Apply: never issued directly from the iframe; a reviewed approval is required
- Restricted node allowlists: global NetGuard plugin surfaces fail closed

Legacy baselines are observe-only until an operator explicitly adopts them.
Plans with management lockout findings remain blocked unless the operator checks
the audited risk-acceptance control.

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
