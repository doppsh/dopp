/* A route's setup as the graph it is: one request comes in, the first branch that matches takes it, its answerers are asked in
   order (moving on when an answer fails, is too slow, or is less sure than the step allows), whoever answered replies, and every
   answer lands on one stored request whose labels are a rule over those answers. Auto-training hangs off the stored requests.
   Laid out from the setup (nothing to drag); click any node to edit it, "+" on an edge to insert a step there. */
import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, getSmoothStepPath, useReactFlow } from "@xyflow/react";
import type { Edge, EdgeProps, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { num, plural } from "../lib/domain";
import { defaultWait, matchText, moveOnText, nameOf, oracleGroups, planWhen, stepName } from "../lib/setup";
import type { AnswererOption } from "../lib/setup";
import type { RouteStep, Setup, SetupPlan, SetupRoute, SetupState } from "../lib/types";

export type GraphOpen = { kind: "route"; id: string; focus?: "oracle" } | { kind: "plan"; id: string } | { kind: "checks" };

type Card = { title: ReactNode; lines?: ReactNode[]; tone?: "plain" | "answer" | "decide" | "store" | "train" | "add"; changed?: boolean; onClick?: () => void; dashed?: boolean; w?: number; label?: string };
const W = 250, STEP = 150;

/* ---------- node and edge renderers ---------- */
const TONE: Record<NonNullable<Card["tone"]>, string> = {
  plain: "border-line bg-surface",
  answer: "border-line bg-surface",
  decide: "border-line bg-panel",
  store: "border-accent/60 bg-accent-soft",
  train: "border-line bg-surface",
  add: "border-dashed border-line bg-transparent text-slate",
};
function CardNode({ data }: NodeProps<Node<Card>>) {
  const d = data;
  const body = (
    <div
      className={`rounded-md border px-3 py-2 text-left text-[12.5px] leading-snug ${TONE[d.tone || "plain"]} ${d.changed ? "!border-accent ring-1 ring-accent/40" : ""} ${d.dashed ? "border-dashed" : ""} ${d.onClick ? "cursor-pointer hover:border-slate" : ""}`}
      style={{ width: d.w || W }}
    >
      {d.label && <div className="mb-0.5 font-mono text-[10.5px] uppercase tracking-wide text-slate">{d.label}</div>}
      <div className="font-semibold text-ink">{d.title}</div>
      {(d.lines || []).map((l, i) => (
        <div key={i} className="mt-0.5 text-slate">
          {l}
        </div>
      ))}
      {d.changed && <div className="mt-1 font-mono text-[10.5px] text-accent">changed</div>}
    </div>
  );
  return (
    <>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="target" id="left" position={Position.Left} className="!opacity-0" />
      <Handle type="target" id="rin" position={Position.Right} className="!opacity-0" />
      {d.onClick ? (
        <button type="button" onClick={d.onClick} className="block rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label={typeof d.title === "string" ? (d.tone === "add" ? d.title.replace(/^\+\s*/, "") : `Edit: ${d.title}`) : "Edit"}>
          {body}
        </button>
      ) : (
        body
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <Handle type="source" id="right" position={Position.Right} className="!opacity-0" />
    </>
  );
}
type EdgeData = { label?: string; tone?: "move" | "reply" | "later"; onAdd?: () => void; addLabel?: string };
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style }: EdgeProps<Edge<EdgeData>>) {
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  const d = data || {};
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {(d.label || d.onAdd) && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan pointer-events-auto absolute flex items-center gap-1" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {d.label && (
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[10.5px] ${d.tone === "move" ? "border-wait/50 bg-wait-soft text-wait" : "border-line bg-paper text-slate"}`}>{d.label}</span>
            )}
            {d.onAdd && (
              <button type="button" onClick={d.onAdd} title={d.addLabel || "Insert a step here"} aria-label={d.addLabel || "Insert a step here"} className="grid h-5 w-5 place-items-center rounded-full border border-line bg-surface text-[13px] leading-none text-slate hover:border-accent hover:text-accent">
                +
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const nodeTypes = { card: CardNode };
const edgeTypes = { flow: FlowEdge };

/* ---------- the layout, from the setup ---------- */
function build(p: Props): { nodes: Node<Card>[]; edges: Edge<EdgeData>[] } {
  const { state, draft, opts, open, setDraft } = p;
  const nodes: Node<Card>[] = [], edges: Edge<EdgeData>[] = [];
  const hasBg = draft.routes.some((r) => r.background.length > 0);
  const COL = W + 70 + (hasBg ? W - 20 : 0);
  const n = draft.routes.length, span = (n - 1) * COL, cx = span / 2;
  const src = state.sources, in24 = Object.values(state.routes_24h || {}).reduce((a, b) => a + (b || 0), 0);
  const add = (id: string, x: number, y: number, data: Card) => nodes.push({ id, type: "card", position: { x, y }, data, draggable: false, selectable: false });
  const edge = (id: string, source: string, target: string, data: EdgeData = {}, opt: Partial<Edge<EdgeData>> = {}) =>
    edges.push({ id, source, target, type: "flow", data, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 }, style: { strokeWidth: 1.4, ...(data.tone === "later" ? { strokeDasharray: "5 4" } : {}) }, ...opt });

  add("in", cx, 0, { label: "request", title: "Your app sends a request", lines: [`${plural(state.keys.length, "key")} · ${num(in24)} in 24h`, `also: Try it ${num(src.typed || 0)} · added ${num((src.pasted || 0) + (src.public || 0) + (src.generated || 0))}`], onClick: () => document.getElementById("connect")?.scrollIntoView({ behavior: "smooth" }) });
  let bottom = 0;
  draft.routes.forEach((r, i) => {
    const x = i * COL, bid = `b:${r.id}`, changed = p.changedRoute(r), editR = () => open({ kind: "route", id: r.id });
    add(bid, x, 130, { label: `branch ${i + 1}${i === n - 1 && n > 1 ? " · the rest" : ""}`, title: r.name || `Branch ${i + 1}`, lines: [`takes: ${matchText(r, state)}`, `${num(state.routes_24h?.[r.id] || 0)} in 24h${r.allow_header ? " · callers may pick" : ""}${r.cache_s ? ` · reuses replies ${r.cache_s} s` : ""}`], tone: "decide", changed, onClick: editR });
    edge(`e:in:${r.id}`, "in", bid, { label: i === 0 ? (n > 1 ? "first match" : undefined) : undefined });
    r.steps.forEach((s: RouteStep, k: number) => {
      const sid = `s:${r.id}:${k}`, a = s.split ? null : opts.find((o) => o.id === s.ask);
      add(sid, x, 270 + k * STEP, { label: k === 0 ? "asks first" : `then asks (${k + 1})`, title: stepName(s, opts), lines: [a ? (a.ready ? `${a.p50_ms != null ? `~${a.p50_ms < 1000 ? a.p50_ms + " ms" : (a.p50_ms / 1000).toFixed(1) + " s"}` : "speed not measured"}${a.per_1000_usd != null ? ` · $${a.per_1000_usd}/1k` : ""}` : `can't answer: ${a.why_not}`) : s.split ? "split between these" : "not in the catalog"], tone: "answer", changed, onClick: editR });
      edge(k === 0 ? `e:${bid}:0` : `e:${r.id}:${k - 1}:${k}`, k === 0 ? bid : `s:${r.id}:${k - 1}`, sid, k === 0 ? {} : { label: `if ${moveOnText(r.steps[k - 1])}`, tone: "move", onAdd: () => insertStep(setDraft, r, k, opts, open) });
    });
    const ry = 270 + r.steps.length * STEP, rid = `r:${r.id}`;
    add(rid, x, ry, { label: "reply", title: "Answer goes back to your app", lines: ["from whoever answered"], tone: "plain", w: W });
    // the last step answers straight down; earlier steps answer when they're fine, along the right side
    r.steps.forEach((_, k) => k === r.steps.length - 1
      ? edge(`e:${r.id}:${k}:reply`, `s:${r.id}:${k}`, rid, { label: "answers", onAdd: () => insertStep(setDraft, r, r.steps.length, opts, open), addLabel: "Add a step after this one (asked when it fails, is slow or unsure)" })
      : edge(`e:${r.id}:${k}:reply`, `s:${r.id}:${k}`, rid, {}, { sourceHandle: "right", targetHandle: "rin" }));
    r.background.forEach((g, j) => {
      const gid = `g:${r.id}:${j}`;
      add(gid, x + W + 50, 270 + j * 110, { label: `also, after the reply · ${g.pct}%`, title: nameOf(g.ask, opts), lines: ["its answer is kept, not sent"], tone: "answer", dashed: true, changed, onClick: editR, w: W - 20 });
      edge(`e:${bid}:g${j}`, bid, gid, {}, { sourceHandle: "right", style: { strokeWidth: 1.2, strokeDasharray: "5 4" } });
    });
    bottom = Math.max(bottom, ry);
  });
  add("addb", n * COL, 130, { title: "+ Add a branch", lines: ["for some kinds, keys or sources"], tone: "add", onClick: p.addRoute, w: 190 });

  // every answer lands on the stored request; its labels are a rule over those answers
  const sy = bottom + 140, groups = oracleGroups(draft);
  add("store", cx - 40, sy, {
    label: "stored request",
    tone: "store",
    w: W + 80,
    title: "Every answer is kept on the request",
    lines: [
      ...groups.map((g) => (
        <span key={g.key}>
          <span className="text-ink">Labels{groups.length > 1 ? ` (${g.routes.map((r) => r.name).join(", ")})` : ""}:</span> {g.oracle.map((o) => nameOf(o, opts)).join(" → ")}
          {g.fill_pct ? ` · ask it later on ${g.fill_pct}%` : ""}
        </span>
      )),
      "your fixes always win",
    ],
    onClick: () => open({ kind: "route", id: groups[0]?.routes[0]?.id || draft.routes[0].id, focus: "oracle" }),
  });
  draft.routes.forEach((r) => edge(`e:r:${r.id}:store`, `r:${r.id}`, "store", { tone: "later" }));
  add("checks", cx + W + 90, sy, { label: "checks", title: `Realism and dataset fit: ${nameOf(draft.checker, opts)}`, lines: ["judges generated requests"], tone: "plain", w: 220, changed: p.checksChanged, onClick: () => open({ kind: "checks" }) });

  // training reads the stored requests; a trained model joins the upstreams
  const py = sy + 170, pw = W + 30, pspan = draft.plans.length * (pw + 40);
  draft.plans.forEach((pl: SetupPlan, i: number) => {
    const pid = `p:${pl.id}`, base = state.bases.find((b) => b.id === pl.base)?.name || pl.base;
    add(pid, cx - pspan / 2 + i * (pw + 40) + 40, py, { label: "trains", title: `${pl.name} · ${base}`, lines: [planWhen(pl), pl.oracle ? `labels: ${pl.oracle.map((o) => nameOf(o, opts)).join(" → ")} (override)` : "labels: as above", "each new version joins the upstreams"], tone: "train", w: pw, changed: p.changedPlan(pl), onClick: () => open({ kind: "plan", id: pl.id }) });
    edge(`e:store:${pl.id}`, "store", pid, { label: pl.auto ? `every ${num(pl.auto.every)} labelled` : "when you press Train", tone: "later" });
  });
  add("addp", cx - pspan / 2 + draft.plans.length * (pw + 40) + 40, py, { title: "+ Add a plan", lines: ["e.g. a phone-sized model"], tone: "add", onClick: p.addPlan, w: 180 });
  return { nodes, edges };
}
/** Insert a step at index k of a route (asked when the one before fails, is slow or unsure), then open the route to set it. */
function insertStep(setDraft: Props["setDraft"], r: SetupRoute, k: number, opts: AnswererOption[], open: Props["open"]) {
  const used = new Set(r.steps.map((s) => s.ask));
  const pick = opts.find((o) => o.ready && !used.has(o.id)) || opts.find((o) => o.ready) || opts[0];
  setDraft((d) => ({ ...d, routes: d.routes.map((x) => (x.id !== r.id ? x : { ...x, steps: [...x.steps.slice(0, k), { ask: pick?.id, wait_ms: defaultWait(pick) }, ...x.steps.slice(k)] })) }));
  open({ kind: "route", id: r.id });
}

type Props = {
  state: SetupState;
  draft: Setup;
  opts: AnswererOption[];
  changedRoute: (r: SetupRoute) => boolean;
  changedPlan: (p: SetupPlan) => boolean;
  checksChanged: boolean;
  open: (d: GraphOpen) => void;
  addRoute: () => void;
  addPlan: () => void;
  setDraft: (fn: (d: Setup) => Setup) => void;
};
function Graph(p: Props) {
  const { nodes, edges } = useMemo(() => build(p), [p]);
  const tall = Math.max(...nodes.map((x) => x.position.y)) + 140;
  const rf = useReactFlow();
  const shape = nodes.map((x) => x.id).join("|");
  useEffect(() => {
    const t = setTimeout(() => rf.fitView({ padding: 0.06, maxZoom: 1, duration: 200 }), 30);
    return () => clearTimeout(t);
  }, [shape, rf]);
  return (
    <div style={{ height: Math.max(480, Math.min(1150, tall * 0.92)) }}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      preventScrolling={false}
      panOnScroll={false}
      minZoom={0.3}
      maxZoom={1.5}
      fitView
      fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} color="var(--line)" />
      <Controls showInteractive={false} position="top-right" />
    </ReactFlow>
    </div>
  );
}
export function SetupGraph(p: Props) {
  return (
    <div className="setup-graph overflow-hidden rounded-lg border border-line bg-paper" role="group" aria-label="The route's setup: request, branches, who answers in order, the reply, the stored request and its labels, and training">
      <ReactFlowProvider>
        <Graph {...p} />
      </ReactFlowProvider>
    </div>
  );
}
