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

One entry with one row of layers (Overview, Nodes, Groups, Zones) and a proof
line under the title that says when the fleet was observed and what that
covers (`observed 03:52:10Z, 41s ago · 33 nodes report · 2 stale · 1 never
reported`). A read that failed prints no count: the proof line says what was
not read, and a number or tab count it would have fed says "unknown" or
nothing, never the zero an empty join produces. The layer, the open node, the
search and the Nodes filter live in the console's address (design 22 page
state), so a reload or a pasted link lands on the same place; old `?lens=` and
`?expand=` links still land.

The page renders on the shared plugin chassis, `@latticenet/plugin-bridge/chassis`:
the same header, tabs, table card, chips and overlays as the other plugin
frames, on the token contract the console publishes. `ui/src/styles.css` adds
only what NetGuard alone needs. `ui/package.json` pins
`@latticenet/plugin-bridge` `0.2.0-alpha.1` from the package registry (GitHub
Packages, `ui/.npmrc`), the first release whose client passes `pageState` and
sends the page state back, and whose chassis carries the layer row, the
non-modal side panel and the table fixes this page used to patch. That version
resolves once the bridge release is published; until then `npm ci` cannot
install it.

- **Overview** (the default): what needs a hand first (ports open to the
  internet that no rule explains, named with their owners; nodes whose live
  table drifted from what Lattice applied; a failed apply), each with the one
  action that clears it. Then four numbers: enforced (managed and in sync),
  unexplained ports, drift, observe only. Then one picture: every port the
  fleet has open to the internet, how many nodes open it and how many of those
  no rule explains, drawn only from fresh snapshots that were read; a port
  opens Nodes on its exact search (`port:22/tcp`), which lists the nodes that
  row counted. A failed overview read leaves ports unjudged: no port is
  called unexplained, the picture is not drawn, and drift, which the server
  computes, stays.
- **Nodes:** one row per node answering what is open to the internet right
  now. The exposure column is computed from the node's reported listeners on
  non-loopback binds, minus what a bound group rule or trusted zone confines;
  a port nothing explains is red. A port the node's SSH knock table gates is
  confined, not open: it prints as a "gated" chip. A click on the row opens the
  node's side panel (`open=<node_id>`) with its unexplained ports and a
  suggestion for each, drift hashes, listening sockets, interfaces, foreign
  nftables tables, and the ruleset its intent compiles to, with the per-node
  review and apply flow. The row's one menu holds Review and apply, Adopt
  baseline and Edit binding; a disabled item says why under its label. A
  filter keeps only the nodes that need attention. The columns stay at 375,
  with the node column pinned.
- **Adopt baseline** asks first, and shows what the next apply installs: the
  baseline's rules, the trusted zones, and the ports open now that the apply
  would close. Adopting writes nothing to the node.
- **Ignore for this session** hides a finding until the page reloads. Nothing
  is saved and nothing stops counting it.
- **Groups:** ordered ingress and egress allow or deny rules over protocols,
  inclusive port ranges, and any/zone/CIDR/node/group/domain remotes, each
  rule read back as a sentence ("allows TCP 22 from 10.7.0.0/24"), with how
  many nodes bind the group; a click on the row folds its rules open. A group
  is attached to nodes through a binding.
- **Zones:** interfaces and CIDRs accepted before any security group is
  evaluated, with how many nodes trust each. This is how a management path
  stays open.

A node that has never reported is never rendered as healthy, and an empty
listener list is never rendered as "nothing open" unless a fresh snapshot says
so. The page reads when it opens and when Refresh is pressed, never on a
timer. One clock re-renders the relative ages ("observed 41s ago", the Seen
column) every 5 seconds while the page is visible and stops while it is
hidden; it reads nothing.

The exposure classification mirrors `lattice-server/internal/netguard/suggest.go`
with two stated differences: a private CIDR remote scopes a rule rather than
opening the port, and an uncovered listener on a managed node whose live table
matches the applied one is closed by the default policy, not exposed.

### Dev harness

`ui/dev.html` runs the real plugin build inside a real iframe against a
stand-in host that speaks the bridge protocol and the production frame model
(the frame is a viewport; `lattice.plugin.resize` is accepted and ignored). It
sends the console's default teal tokens and keeps the plugin's page state in
its own address, the way the console does.

```sh
cd ui
npm ci
npm run dev
# http://localhost:5183/dev.html?scenario=fleet&width=1440
# scenario=fleet|empty|readonly|failing  width=1440|1024|375  theme=dark|light
# frame=<pane height>  zoom=<factor>  latency=<ms, holds every answer to look at the skeleton>
# any other key is page state: view=nodes&open=metix-dmit-2&show=attention
# oldhost=1 plays a console from before page state (plugin=<query> then reaches the frame's own query)
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
