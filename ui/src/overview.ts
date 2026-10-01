/**
 * The Overview layer: what needs a hand, four numbers, and one picture of
 * what the fleet has open to the internet.
 *
 * Everything here is drawn from the same join the Nodes table reads (intent,
 * the reality roster, and each node's full snapshot as it lands), so the
 * Overview and the table can never disagree. Nothing counts evidence that was
 * not read: a node whose snapshot is stale, missing or still loading adds no
 * port to the picture and no finding to the attention list, and a number
 * whose read failed says "unknown" instead of the zero an empty join prints.
 *
 * Two reads feed it. Reality (the roster and each snapshot) says what is
 * open and, through the server's drift_state, whether a live table matches
 * what Lattice applied. The overview says what was declared. A port is
 * "unexplained" only against declared rules, so after a failed overview read
 * no port is counted as unexplained, while drift, computed by the server from
 * the stored binding and the snapshot, stays known.
 */
import { formatProcesses, formatSpan, type NodeExposure, type Protocol, type Verdict } from "./exposure";
import type { PostureCounts, PostureRow } from "./posture";

/** Whether this node's full snapshot has been fetched yet. */
export type DetailState = "pending" | "loaded" | "failed";

export interface ExposureRowView {
  row: PostureRow;
  exposure: NodeExposure;
  detail: DetailState;
}

/** A row whose open ports can be believed: fresh snapshot, read in full. */
export function hasFreshEvidence(view: ExposureRowView): boolean {
  return view.detail === "loaded" && view.exposure.evidence === "fresh";
}

/** Whether a node needs a hand: open ports no rule explains, drift, or a failed apply. Drives the Nodes filter. */
export function needsAttention(view: ExposureRowView): boolean {
  return (hasFreshEvidence(view) && view.exposure.unexplained > 0) || view.row.driftState === "drift" || Boolean(view.row.lastError);
}

// ── attention ─────────────────────────────────────────────────────────────

export type AttentionTone = "danger" | "warning" | "info";

/** Where an item's action leads: one node's panel, or the Nodes layer filtered to what needs a hand. */
export type AttentionAction = { label: string; kind: "open"; nodeId: string } | { label: string; kind: "nodes" };

export interface AttentionItem {
  key: string;
  tone: AttentionTone;
  /** The claim, with its count. */
  claim: string;
  /** The rows that prove it, named. */
  proof: string;
  action: AttentionAction;
}

const PROOF_NODES = 3;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "a, b, c and 4 more" */
function namedList(names: readonly string[], limit = PROOF_NODES): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

function actionFor(rows: readonly PostureRow[], label: string): AttentionAction {
  const only = rows.length === 1 ? rows[0] : undefined;
  return only ? { label: `Open ${only.nodeName}`, kind: "open", nodeId: only.nodeId } : { label, kind: "nodes" };
}

/**
 * The attention list, most urgent first: ports open to the internet that no
 * rule explains, nodes whose live table drifted from what Lattice applied,
 * then applies that failed. A node's ports are named with their owners so the
 * claim can be checked without opening anything.
 */
export function attentionItems(
  views: readonly ExposureRowView[],
  options: { canSeeReality: boolean; realityFailed: boolean; overviewFailed: boolean },
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const readable = options.canSeeReality && !options.realityFailed;

  if (readable) {
    // Unexplained means no declared rule allows it; with the rules unread the
    // claim cannot be made, whatever the exposure join was handed.
    const exposed = options.overviewFailed ? [] : views.filter((view) => hasFreshEvidence(view) && view.exposure.unexplained > 0);
    if (exposed.length) {
      const ports = exposed.reduce((sum, view) => sum + view.exposure.unexplained, 0);
      const proof = exposed.slice(0, PROOF_NODES).map((view) => {
        const spans = view.exposure.open.filter((span) => span.verdict === "unexplained");
        const listed = spans.slice(0, 3).map((span) => [formatSpan(span), formatProcesses(span)].filter(Boolean).join(" "));
        return `${view.row.nodeName} ${listed.join(", ")}${spans.length > 3 ? `, +${spans.length - 3}` : ""}`;
      });
      const rest = exposed.length - PROOF_NODES;
      items.push({
        key: "unexplained",
        tone: "danger",
        claim: `${plural(ports, "port", "ports")} open to the internet with no rule, on ${plural(exposed.length, "node", "nodes")}`,
        proof: `${proof.join(" · ")}${rest > 0 ? ` · and ${rest} more ${rest === 1 ? "node" : "nodes"}` : ""}`,
        action: actionFor(exposed.map((view) => view.row), "Review"),
      });
    }

    const drifted = views.filter((view) => view.row.driftState === "drift").map((view) => view.row);
    if (drifted.length) {
      items.push({
        key: "drift",
        tone: "danger",
        claim: `${plural(drifted.length, "node", "nodes")} drifted: the live table differs from what Lattice applied`,
        proof: namedList(drifted.map((row) => row.nodeName)),
        action: actionFor(drifted, "Review"),
      });
    }
  }

  const failed = views.filter((view) => view.row.lastError).map((view) => view.row);
  if (failed.length) {
    items.push({
      key: "apply-failed",
      tone: "warning",
      // last_error is free text; whether anything was rolled back is the
      // error's to say, and the proof quotes it.
      claim: `${failed.length === 1 ? "The last apply" : `The last apply on ${failed.length} nodes`} failed`,
      proof: failed.length === 1 ? `${failed[0]!.nodeName}: ${failed[0]!.lastError}` : namedList(failed.map((row) => row.nodeName)),
      action: actionFor(failed, "Show"),
    });
  }
  return items;
}

/**
 * What the Nodes attention filter says when it keeps no node. "No node
 * needs attention" is an all-clear, so it is said only when both reads
 * landed; otherwise the copy names what was checked and what is not known.
 */
export function attentionEmptyCopy(input: { realityRead: boolean; realityScoped: boolean; rulesRead: boolean; reading: boolean }): {
  title: string;
  body: string;
  allClear: boolean;
} {
  if (!input.realityRead) {
    const why = input.realityScoped ? "node reality was not read" : "this session cannot read node reality";
    return { title: "No node has a failed apply", body: `No node's last apply failed. Open ports and drift are not known: ${why}.`, allClear: false };
  }
  if (!input.rulesRead) {
    return {
      title: "No node has drifted or failed an apply",
      body: "No node has a drifted table or a failed apply. Whether a port is open with no rule is not known: the rules were not read.",
      allClear: false,
    };
  }
  return {
    title: "No node needs attention",
    body: `No node has a port open with no rule, a drifted table or a failed apply${input.reading ? ", on the snapshots read so far" : ""}.`,
    allClear: true,
  };
}

// ── numbers ───────────────────────────────────────────────────────────────

export type NumberTone = "warning" | "error" | "neutral";

export interface OverviewNumber {
  key: string;
  label: string;
  value: string;
  note: string;
  tone?: NumberTone;
  /** The read that feeds this number did not answer; the value is a placeholder, not a count. */
  unknown: boolean;
}

export const UNKNOWN_VALUE = "unknown";

export interface NumberSource {
  overviewFailed: boolean;
  realityFailed: boolean;
  canSeeReality: boolean;
  /** Snapshot reads still in flight. */
  reading: { done: number; total: number };
}

function unknown(key: string, label: string, note: string): OverviewNumber {
  return { key, label, value: UNKNOWN_VALUE, note, tone: "neutral", unknown: true };
}

/**
 * The four numbers: enforced, unexplained ports, drift, observe only. Each is
 * a number that moves when the operator acts; the fleet total rides along as
 * the denominator of the first, and the rest of the roster (legacy baselines,
 * unbound nodes) is named in a note so the four add up to something.
 */
export function overviewNumbers(counts: PostureCounts, views: readonly ExposureRowView[], source: NumberSource): OverviewNumber[] {
  const realityNote = source.realityFailed ? "reality could not be loaded" : "reality not readable by this session";
  const realityMissing = source.realityFailed || !source.canSeeReality;
  const overviewNote = "the overview could not be loaded";
  const enforcedCount = views.filter((view) => view.row.coverage === "managed" && view.row.driftState === "in_sync").length;

  const enforced: OverviewNumber = source.overviewFailed
    ? unknown("enforced", "Enforced", overviewNote)
    : realityMissing
      ? unknown("enforced", "Enforced", realityNote)
      : {
          key: "enforced",
          label: "Enforced",
          value: `${enforcedCount} / ${counts.total}`,
          note: `managed and in sync · ${counts.managed} managed`,
          unknown: false,
        };

  const reading = source.reading.total > 0 && source.reading.done < source.reading.total;
  const fresh = views.filter(hasFreshEvidence);
  const ports = fresh.reduce((sum, view) => sum + view.exposure.unexplained, 0);
  const onNodes = fresh.filter((view) => view.exposure.unexplained > 0).length;
  // Both reads are needed: the sockets from reality, the rules from the overview.
  const unexplained: OverviewNumber = realityMissing
    ? unknown("unexplained", "Unexplained ports", realityNote)
    : source.overviewFailed
      ? unknown("unexplained", "Unexplained ports", overviewNote)
      : {
          key: "unexplained",
          label: "Unexplained ports",
          value: String(ports),
          note: reading
            ? `reading ${source.reading.done} of ${source.reading.total} snapshots`
            : ports
              ? `open with no rule, on ${plural(onNodes, "node", "nodes")}`
              : `none on ${plural(fresh.length, "fresh snapshot", "fresh snapshots")}`,
          tone: ports ? "error" : undefined,
          unknown: false,
        };

  // The server computes drift_state on the reality roster from the stored
  // binding and the snapshot, so a failed overview read leaves it known.
  const drift: OverviewNumber = realityMissing
    ? unknown("drift", "Drift", realityNote)
    : {
        key: "drift",
        label: "Drift",
        value: String(counts.drifted),
        note: counts.drifted ? "live table differs from what Lattice applied" : `${counts.inSync} in sync · ${counts.driftUnknown} not comparable`,
        tone: counts.drifted ? "error" : undefined,
        unknown: false,
      };

  const others = [
    counts.legacy ? plural(counts.legacy, "legacy baseline", "legacy baselines") : "",
    counts.unbound ? `${counts.unbound} unbound` : "",
  ].filter(Boolean);
  const observe: OverviewNumber = source.overviewFailed
    ? unknown("observe", "Observe only", overviewNote)
    : {
        key: "observe",
        label: "Observe only",
        value: String(counts.observeOnly),
        note: others.length ? `nothing enforced · also ${others.join(", ")}` : "visible, nothing enforced",
        tone: "neutral",
        unknown: false,
      };

  return [enforced, unexplained, drift, observe];
}

// ── the picture: open to the internet, by port ────────────────────────────

export interface PortNode {
  nodeId: string;
  nodeName: string;
  verdict: Verdict;
}

export interface PortRow {
  key: string;
  /** "5432/tcp", "31001-31012/tcp". */
  label: string;
  /** The Nodes search that lists exactly this row's nodes: "port:5432/tcp". */
  search: string;
  processes: string[];
  unexplained: number;
  unknown: number;
  allowed: number;
  total: number;
  nodes: PortNode[];
}

export interface PortPicture {
  rows: PortRow[];
  /** Nodes whose open ports went into the picture. */
  counted: number;
  /** Nodes left out, and why. */
  stale: number;
  neverReported: number;
  unread: number;
}

/** Whether a node's open ports go into the picture, and if not, why. */
export type PictureEvidence = "counted" | "stale" | "never" | "unread";

export function pictureEvidence(view: ExposureRowView): PictureEvidence {
  if (view.row.snapshotStatus === "unknown") return "never";
  if (view.exposure.evidence === "stale" || view.row.snapshotStatus === "stale") return "stale";
  if (view.detail !== "loaded") return "unread";
  return "counted";
}

// ── the port search: one picture row, as a Nodes search ─────────────────────

/** An exact open port or bank: "port:22/tcp", "port:31001-31012/tcp". */
export interface PortQuery {
  from: number;
  to: number;
  /** Either protocol when the search names none. */
  protocol?: Protocol;
}

const PORT_QUERY = /^port:(\d{1,5})(?:-(\d{1,5}))?(?:\/(tcp|udp))?$/;

/** "22/tcp", "31001-31012/tcp", "36712/udp": the protocol always named, once. */
export function portLabel(span: { from: number; to: number; protocol: Protocol }): string {
  return `${span.from === span.to ? span.from : `${span.from}-${span.to}`}/${span.protocol}`;
}

/** The search a picture row opens Nodes with. It reads as what it means in the address: q=port:22/tcp. */
export function portSearch(span: { from: number; to: number; protocol: Protocol }): string {
  return `port:${portLabel(span)}`;
}

/** A port search, or undefined for any other text. Case and surrounding space are the caller's to fold. */
export function parsePortQuery(text: string): PortQuery | undefined {
  const match = PORT_QUERY.exec(text);
  if (!match) return undefined;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to > 65535 || to < from) return undefined;
  return { from, to, ...(match[3] ? { protocol: match[3] as Protocol } : {}) };
}

/**
 * Whether a node opens exactly this port or bank on a snapshot the picture
 * counts. Exact, not contained: the picture keeps "22/tcp" and "21-23/tcp" on
 * separate rows, and a row's search has to list the nodes that row counted,
 * no more and no fewer. A substring search for "22" also found 2222, 8022, a
 * node named "...-22" and udp 22.
 */
export function matchesPortQuery(view: ExposureRowView, query: PortQuery): boolean {
  if (pictureEvidence(view) !== "counted") return false;
  return view.exposure.open.some(
    (span) => span.from === query.from && span.to === query.to && (query.protocol === undefined || span.protocol === query.protocol),
  );
}

/**
 * Every port the fleet has open to the internet, one row per port or bank,
 * with how many nodes open it and how many of those no rule explains. Ports
 * with an unexplained node sort first, then the most common. Confined ports
 * (a zone bind, the knock gate) are not open to the internet and stay out.
 */
export function portPicture(views: readonly ExposureRowView[]): PortPicture {
  const rows = new Map<string, PortRow>();
  let counted = 0;
  let stale = 0;
  let neverReported = 0;
  let unread = 0;
  for (const view of views) {
    const evidence = pictureEvidence(view);
    if (evidence === "never") {
      neverReported += 1;
      continue;
    }
    if (evidence === "stale") {
      stale += 1;
      continue;
    }
    if (evidence === "unread") {
      unread += 1;
      continue;
    }
    counted += 1;
    for (const span of view.exposure.open) {
      const key = `${span.protocol}:${span.from}-${span.to}`;
      let row = rows.get(key);
      if (!row) {
        row = { key, label: portLabel(span), search: portSearch(span), processes: [], unexplained: 0, unknown: 0, allowed: 0, total: 0, nodes: [] };
        rows.set(key, row);
      }
      for (const process of span.processes) if (!row.processes.includes(process)) row.processes.push(process);
      row[span.verdict] += 1;
      row.total += 1;
      row.nodes.push({ nodeId: view.row.nodeId, nodeName: view.row.nodeName, verdict: span.verdict });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => {
    if ((b.unexplained > 0 ? 1 : 0) !== (a.unexplained > 0 ? 1 : 0)) return (b.unexplained > 0 ? 1 : 0) - (a.unexplained > 0 ? 1 : 0);
    if (b.unexplained !== a.unexplained) return b.unexplained - a.unexplained;
    if (b.total !== a.total) return b.total - a.total;
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  });
  for (const row of sorted) row.nodes.sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict) || a.nodeName.localeCompare(b.nodeName));
  return { rows: sorted, counted, stale, neverReported, unread };
}

function verdictRank(verdict: Verdict): number {
  return verdict === "unexplained" ? 0 : verdict === "unknown" ? 1 : 2;
}
