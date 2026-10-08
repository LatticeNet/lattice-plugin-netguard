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
query and the Nodes filter live in the console's address (design 22 page
state), so a reload or a pasted link lands on the same place; old `?lens=` and
`?expand=` links still land.

The page renders on the shared plugin chassis, `@latticenet/plugin-bridge/chassis`:
the same header, tabs, table card, chips and overlays as the other plugin
frames, on the token contract the console publishes. `ui/src/styles.css` adds
only what NetGuard alone needs. `ui/package.json` pins
`@latticenet/plugin-bridge` `0.2.0-alpha.3` from the package registry (GitHub
Packages, `ui/.npmrc`), and the lock holds it to the published tarball and its
integrity. Its client passes `pageState` and sends the page state back; its
chassis carries the layer row, the non-modal side panel and the table fixes
this page used to patch, starts the side panel and the modal at the frame's
top edge, and draws the side panel's header the way the console draws a
sheet's. It also carries the console's list query: the search, filter and
sort syntax in `@latticenet/plugin-bridge/query`, and `PcQueryBar` and
`useListQuery` in the chassis.

- **Overview** (the default): what needs a hand first (ports open to the
  internet that no rule explains, named with their owners; nodes whose live
  table drifted from what Lattice applied; a failed apply), each with the one
  action that clears it. Then four numbers: enforced (managed and in sync),
  unexplained ports, drift, observe only. Then one picture: every port the
  fleet has open to the internet, how many nodes open it and how many of those
  no rule explains, drawn only from fresh snapshots that were read; a port
  opens Nodes on its exact query (`port:22/tcp`), which lists the nodes that
  row counted. A failed overview read leaves ports unjudged: no port is
  called unexplained, the picture is not drawn, and drift, which the server
  computes, stays.
- **Nodes:** one line per node answering what is open to the internet right
  now. Status, beside the name, is the node's verdict: drifted, apply failed,
  ports with no rule, stale, never reported, not read, not judged, then the
  quiet states (enforced, never applied, not enforced, no binding). Its dot
  is red on exactly the nodes the Needs attention filter keeps, including
  for a session that can read only intent, where a failed apply still shows.
  The table opens sorted by Status, worst first: drifted, apply failed, most
  ports with no rule, then the warnings, the neutral states and enforced.
  The ports column is computed from the node's reported listeners on
  non-loopback binds, minus what a bound group rule or trusted zone
  confines; a port nothing explains is a flagged token, listed first. A port the node's SSH
  knock table gates is confined, not open: it reads "22 gated" in the quiet
  phrase after the open ports. The node id is printed under the name only
  when it is not the name's slug. A click on the row opens the node's side
  panel (`open=<node_id>`) with its unexplained ports and a suggestion for
  each, drift hashes, listening sockets, interfaces, foreign nftables
  tables, and the ruleset its intent compiles to, with the per-node review
  and apply flow. The row's one menu holds Review and apply, Adopt baseline
  and Edit binding; a disabled item says why under its label. A segmented
  filter, All or Needs attention, each with its count, keeps only the nodes
  that need attention; its counts appear only when the reads behind them
  landed. From 480 to 720 the node column is pinned and carries the verdict
  on a line under the name; below 480 each row folds into the node and its
  menu, then the verdict, then every port, wrapped.
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

Nodes, Groups and Zones each take the console's list query in one field above
the list (`PcQueryBar`): space-separated terms that must all match, `OR`,
parentheses, `-term` to leave rows out, `field:value`, comparisons such as
`unexplained>0` or `seen>1h`, `is:flag`, and `sort:field` or `sort:-field`.
The fields are each list's own, read from what its table shows
(`ui/src/listQueries.ts`). Nodes has `status` (the Status column's verdict:
`drifted`, `apply_failed`, `no_rule`, `stale`, `never_reported` and the rest,
sorted worst first), `coverage`, `drift`, `snapshot`, `group`, `zone`, `port`
(exact, as the Overview's picture counts it), `process`, `unexplained`,
`open`, `foreign`, `seen`, `applied`, the flags `is:attention`, `is:drifted`,
`is:failed` and `is:enforced`, and the console's shared `name` and `id`; the
plugin contract carries no online state, address or agent report, so the rest
of the console's node fields are not offered. Groups has `name`, `id`,
`rules`, `nodes`, `node`, `port`, `remote`, `protocol`, `direction`,
`action`, `comment`, `version` and `is:legacy`, and a query that reaches
inside a rule opens that group while it stands. Zones has `name`, `id`,
`interface`, `cidr`, `nodes` and `is:builtin`. A bare word searches what the
old search field did. Each layer keeps its own query for the visit, and the
address carries the one on screen as `q`. A negated term leaves out only the
rows known to match it, as on the console: `-port:5432/tcp` keeps a node that
never reported or whose snapshot is stale or still being read, and its Status
says which; add `snapshot:fresh` to keep only nodes known to lack the port.
While the text does not read, the
list shows the last query that did, dimmed and inert, and the field says why.
A Nodes header click takes the order back from a query's `sort:`, or from the
relevance a bare word ranks by, until the text changes.

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
