/* The request pool's rows and one request opened. Shared by Requests (every route) and a route's page (its latest).
   A row: when, which route, the request, who answered and how fast (and why it moved on), the answers with their
   confidence, and the labels with who they came from. Opened: every upstream's answers side by side with every option's
   probability, the labels, and a person's fixes. */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "./Badge";
import { Button, LinkButton, QuietLink } from "./Button";
import { Chips } from "./Bits";
import { Drawer } from "./Drawer";
import { Answer, StateBox } from "./Example";
import { useToast } from "./Toast";
import { correctRequest } from "../lib/api";
import { markRequestOpened } from "../lib/onboarding";
import { tint } from "./Chunks";
import { ago, chunkSource, displayAnswer, fmtMs, fmtT, labelValue, optionsOf, paletteOf, pct, sourceTag, stateText } from "../lib/domain";
import type { Ans, Questions, Req, Source } from "../lib/types";

export const SKIP = "__skip__";

/* ---------- reading a request ---------- */

/** The key the served upstream's answers are stored under ("model" on its own route is `model:<route>`). */
export function keyOf(r: Req, id: string | null | undefined): string | null {
  if (!id) return null;
  if (r.answers?.[id]) return id;
  if (id === "model" || /^model@\d+$/.test(id) || id.startsWith(`model:${r.route}@`)) return r.answers?.[`model:${r.route}`] ? `model:${r.route}` : id;
  const m = id.match(/^model:([^@]+)@/);
  if (m && r.answers?.[`model:${m[1]}`]) return `model:${m[1]}`;
  return id;
}

export const answerOf = (r: Req, upstream: string, q: string): Ans | null => r.answers?.[keyOf(r, upstream) || upstream]?.[q] ?? null;

/** A per-word kind: the text its chunks point into, and a colour slot per option. */
function chunkView(r: Req): { text: string; palette: Record<string, number> } | null {
  if (!r.chunks?.length) return null;
  const text = chunkSource(r.state, null, r.chunks);
  if (!text) return null;
  const first = r.questions?.[r.chunks[0].id];
  return { text, palette: paletteOf(optionsOf(first)) };
}

/** "pii 6 · none 26" for one upstream's answers on a per-word request, coloured like the text. */
function ChunkCounts({ r, upstream, palette }: { r: Req; upstream: string; palette: Record<string, number> }) {
  const a = r.answers?.[keyOf(r, upstream) || upstream];
  if (!a) return null;
  const n: Record<string, number> = {};
  let unsure = 0;
  for (const x of Object.values(a)) {
    if (!x) continue;
    n[x.answer] = (n[x.answer] || 0) + 1;
    if (x.p != null && x.p < 0.5) unsure++;
  }
  const xs = Object.entries(n).sort((p, q) => (palette[q[0]] ? 1 : 0) - (palette[p[0]] ? 1 : 0) || q[1] - p[1]);
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-xs">
      {xs.map(([k, v]) => (
        <span key={k} className="whitespace-nowrap">
          <span className="rounded-sm px-0.5" style={tint(palette[k])}>
            {k}
          </span>{" "}
          <span className="tnum text-slate">{v}</span>
        </span>
      ))}
      {unsure > 0 && <span className="text-wait">{unsure} below 50%</span>}
    </span>
  );
}

/** The text with each word tinted by its label (a person's fix, else the labels, else the served answer). */
function ChunkLine({ r, v, clamp, pick, against }: { r: Req; v: { text: string; palette: Record<string, number> }; clamp: boolean; pick?: (id: string) => string | null; against?: (id: string) => string | null }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const c of [...(r.chunks || [])].sort((a, b) => a.start - b.start)) {
    if (c.start < at) continue;
    if (c.start > at) out.push(v.text.slice(at, c.start));
    const l = pick ? pick(c.id) : labelOf(r, c.id).raw ?? answerOf(r, r.served || "", c.id)?.answer ?? null;
    const o = against ? against(c.id) : null;
    const differs = o != null && l != null && o !== l;
    out.push(
      <span
        key={c.id}
        className="rounded-sm"
        style={{ ...tint(l != null ? v.palette[l] : undefined), ...(differs ? { outline: "2px solid var(--stop)", outlineOffset: 1 } : {}) }}
        title={`${c.text}: ${l ?? "no answer"}${differs ? ` (the label says ${o})` : ""}`}
      >
        {v.text.slice(c.start, c.end)}
      </span>,
    );
    at = c.end;
  }
  if (at < v.text.length) out.push(v.text.slice(at));
  return <span className={`block whitespace-pre-wrap break-words text-sm leading-relaxed text-ink ${clamp ? "clamp-2" : ""}`}>{out}</span>;
}

/** Every upstream that answered, the one that was served first. */
export function answeredBy(r: Req): string[] {
  const have = Object.keys(r.answers || {}).filter((k) => r.answers[k] && Object.keys(r.answers[k]!).length);
  const sk = keyOf(r, r.served);
  return [...(sk && have.includes(sk) ? [sk] : []), ...have.filter((k) => k !== sk).sort()];
}

/** The label for one question: a person's fix wins; otherwise the labels the request has (and whose they are). */
export function labelOf(r: Req, q: string): { raw: string | null; skip: boolean; by: "person" | string | null; a: Ans | null } {
  const c = r.corrections?.[q];
  if (c) return c.label === SKIP ? { raw: null, skip: true, by: "person", a: null } : { raw: String(c.label), skip: false, by: "person", a: { answer: String(c.label) } };
  const l = r.labels?.[q];
  return l ? { raw: String(l.answer), skip: false, by: r.labels_from, a: l } : { raw: null, skip: false, by: null, a: null };
}

const qids = (r: Req) => (Object.keys(r.questions || {}).length ? Object.keys(r.questions) : Object.keys(r.answers?.[keyOf(r, r.served) || ""] || {}));

/** The least sure served answer, for the row's confidence hint. */
export function leastSure(r: Req, upstream = r.served): number | null {
  const a = upstream ? r.answers?.[keyOf(r, upstream) || upstream] : null;
  if (!a) return null;
  const ps = Object.values(a).map((x) => x?.p).filter((p): p is number => typeof p === "number");
  return ps.length ? Math.min(...ps) : null;
}

const REASON: Record<string, string> = { error: "failed", slow: "was too slow", unsure: "was unsure", skipped: "was skipped" };

/** "Broken service failed → Jev", "support-triage v1 was unsure (62%) → Jev", or null when the first step answered. */
export function pathText(r: Req, name: (id: string) => string): string | null {
  const steps = r.path?.steps || [];
  const moved = steps.filter((s) => !s.ok || (r.path?.served && s.ask !== r.path.served));
  if (!moved.length) return null;
  const parts = moved.map((s) => {
    const why = REASON[s.reason || ""] || (s.ok ? "was passed over" : "failed");
    const extra = s.reason === "unsure" && s.conf != null ? ` (${pct(s.conf)})` : s.reason === "error" && s.code ? ` (HTTP ${s.code})` : "";
    return `${name(s.ask)} ${why}${extra}`;
  });
  return `${parts.join(" → ")} → ${r.served ? name(r.served) : "nobody"}`;
}

/* ---------- the list ---------- */

export interface ListProps {
  rows: Req[];
  /** skeleton rows to draw while loading */
  loading?: number;
  empty?: ReactNode;
  name: (id: string) => string;
  onOpen: (r: Req) => void;
  showRoute?: boolean;
  /** [a, b]: two answer columns, differences in red */
  compare?: [string, string] | null;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: () => void;
  allOnPage?: boolean;
  fresh?: Set<string>;
  narrow: boolean;
}

const MAXQ = 3;

function AnswersCell({ r, upstream, other, name }: { r: Req; upstream: string | null; other?: string | null; name?: (id: string) => string }) {
  if (!upstream || !r.answers?.[keyOf(r, upstream) || upstream]) return <span className="text-xs text-slate">{upstream && name ? `no answer from ${name(upstream)}` : "not answered"}</span>;
  const cv = chunkView(r);
  if (cv) {
    const diff = other ? qids(r).filter((q) => { const a = answerOf(r, upstream, q), o = answerOf(r, other, q); return a && o && a.answer !== o.answer; }).length : 0;
    return (
      <span className="flex flex-col gap-0.5">
        <ChunkCounts r={r} upstream={upstream} palette={cv.palette} />
        {diff > 0 && <span className="text-2xs text-stop">differs on {diff} words</span>}
      </span>
    );
  }
  const qs = qids(r);
  const shown = qs.slice(0, MAXQ);
  return (
    <div className="min-w-0 space-y-0.5">
      {shown.map((q) => {
        const a = answerOf(r, upstream, q);
        const o = other ? answerOf(r, other, q) : null;
        return (
          <div key={q} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            {qs.length > 1 && <code className="truncate font-mono text-2xs text-slate" title={q}>{q}</code>}
            <Answer def={r.questions?.[q]} a={a} differs={!!(a && o && a.answer !== o.answer)} />
          </div>
        );
      })}
      {qs.length > MAXQ && <span className="text-2xs text-slate">+{qs.length - MAXQ} more questions</span>}
    </div>
  );
}

function LabelCell({ r, name }: { r: Req; name: (id: string) => string }) {
  const fixes = Object.keys(r.corrections || {}).length;
  const qs = qids(r);
  const labelled = qs.filter((q) => labelOf(r, q).raw != null || labelOf(r, q).skip).length;
  if (!labelled)
    return (
      <span className="text-xs text-slate" title={r.pending_label || undefined}>
        not labelled{r.pending_label ? <span className="block text-wait">{r.pending_label}</span> : null}
      </span>
    );
  const from = r.labels_from ? name(r.labels_from) : null;
  const served = r.served ? r.answers?.[keyOf(r, r.served) || r.served] : null;
  const differs = served ? qs.filter((q) => { const l = labelOf(r, q); return l.raw != null && served[q] && served[q]!.answer !== l.raw; }).length : 0;
  return (
    <span className="flex flex-col text-xs">
      <span className="text-ink">
        {from ? `from ${from}` : fixes ? "from you" : "labelled"}
        {labelled < qs.length && <span className="text-slate"> · {labelled}/{qs.length}</span>}
      </span>
      {fixes > 0 && from && <span className="text-slate">{fixes} fixed by you</span>}
      {differs > 0 && <span className="text-stop">differs from the served answer on {differs}</span>}
    </span>
  );
}

/** Who answered, with the version when a trained model did ("support-triage v1"). */
export function servedName(r: Req, name: (id: string) => string): string {
  if (!r.served) return "nobody";
  const v = (r as Req & { v?: number | null }).v;
  const n = name(r.served);
  if (v && (r.served === "model" || r.served.startsWith("model"))) return n.replace(/ \(any version\)$| model$| v\d+$/, "") + ` v${v}`;
  return n;
}

function AnsweredCell({ r, name }: { r: Req; name: (id: string) => string }) {
  const p = pathText(r, name);
  const ms = r.served ? r.ms?.[r.served] ?? r.ms?.[keyOf(r, r.served) || ""] : null;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm text-ink">{servedName(r, name)}</span>
      <span className="font-mono text-2xs text-slate">
        {r.waited_ms != null ? (
          <>
            <span className="text-ink">waited {fmtMs(r.waited_ms)}</span>
            {ms != null && ` · ${servedName(r, name)} ${fmtMs(ms)}`}
          </>
        ) : ms != null ? (
          fmtMs(ms)
        ) : (
          ""
        )}
      </span>
      {p && (
        <span className="mt-0.5">
          <Badge tone="wait" className="!whitespace-normal !text-2xs" title="Where this request went before it was answered">
            {p}
          </Badge>
        </span>
      )}
    </span>
  );
}

/** A flat object state reads as "asked: Who sent you? · visitor_reply: thomas"; anything else as its JSON. */
/** A state as one line of words ("field: value · …") when it is flat, else its JSON. */
export function readableState(state: unknown): string {
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const xs = Object.entries(state as Record<string, unknown>);
    const scalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);
    if (xs.every(([, v]) => scalar(v))) return xs.map(([k, v]) => `${k}: ${v}`).join(" · ");
    // mixed: the words first (a command, a message), then each list or object by its size, so a long context doesn't hide the text
    if (xs.some(([, v]) => typeof v === "string")) return [...xs.filter(([, v]) => scalar(v)).map(([k, v]) => `${k}: ${v}`),
      ...xs.filter(([, v]) => !scalar(v)).map(([k, v]) => { const n = Array.isArray(v) ? v.length : Object.keys(v as object).length; return `${k}: ${n ? n + (Array.isArray(v) ? (n === 1 ? " item" : " items") : (n === 1 ? " field" : " fields")) : "none"}`; })].join(" · ");
  }
  return stateText(state);
}

function Snippet({ r, lines = 2 }: { r: Req; lines?: number }) {
  const text = readableState(r.state);
  const cv = chunkView(r);
  return (
    <span className="block min-w-0">
      {cv ? (
        <ChunkLine r={r} v={cv} clamp={lines === 2} />
      ) : (
        <span className={`break-words text-sm text-ink ${lines === 2 ? "clamp-2" : "block"}`} title={text.slice(0, 400)}>
          {text || <span className="text-slate">empty state</span>}
        </span>
      )}
      <span className="mt-0.5 block truncate text-2xs text-slate">
        {r.kind_name || "a kind of request"} · {sourceTag({ source: r.source as Source | null, via: r.via })}
        {r.holdout ? " · held out" : ""}
        {r.excluded && (
          <span className="ml-1.5 rounded border border-wait/40 px-1 text-wait" title={leftOutWhy(r)}>
            left out
          </span>
        )}
      </span>
    </span>
  );
}

/** Why a request doesn't train, in plain words. */
export const leftOutWhy = (r: Req) => (r.left_out === "realism" ? "didn't read like your requests" : "left out by a person");

function Check({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
      checked={on}
      onClick={(e) => e.stopPropagation()}
      onChange={onChange}
    />
  );
}

export function RequestList({ rows, loading, empty, name, onOpen, showRoute = true, compare, selected, onToggle, onToggleAll, allOnPage, fresh, narrow }: ListProps) {
  const selectable = !!selected && !!onToggle;
  if (narrow) {
    return (
      <div className="space-y-2">
        {selectable && rows.length > 0 && (
          <label className="flex items-center gap-2 px-1 text-sm text-slate">
            <Check on={!!allOnPage} onChange={() => onToggleAll?.()} label="Select every request shown" /> Select all shown
          </label>
        )}
        {loading
          ? Array.from({ length: loading }).map((_, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-line bg-surface p-3">
                <span className="skel h-3 w-1/3" />
                <span className="skel h-3 w-full" />
                <span className="skel h-3 w-2/3" />
              </div>
            ))
          : !rows.length
            ? <div className="rounded-lg border border-line bg-surface px-3 py-6 text-sm text-slate">{empty}</div>
            : rows.map((r) => (
                <div
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(r)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(r))}
                  className={`block w-full cursor-pointer rounded-lg border border-line bg-surface p-3 text-left hover:border-slate ${fresh?.has(r.id) ? "fresh" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    {selectable && <span className="pt-0.5"><Check on={selected!.has(r.id)} onChange={() => onToggle!(r.id)} label="Select this request" /></span>}
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-2xs text-slate">
                        <span className="truncate">{showRoute ? r.route_name : ""}</span>
                        <span className="font-mono" title={fmtT(r.t)}>{ago(r.t)}</span>
                      </p>
                      <Snippet r={r} />
                      <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-line pt-2">
                        <AnsweredCell r={r} name={name} />
                        <AnswersCell r={r} upstream={compare ? compare[0] : r.served} other={compare ? compare[1] : null} name={name} />
                        {compare && (
                          <div>
                            <p className="text-2xs text-slate">{name(compare[1])}</p>
                            <AnswersCell r={r} upstream={compare[1]} other={compare[0]} name={name} />
                          </div>
                        )}
                        <LabelCell r={r} name={name} />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
      </div>
    );
  }

  const th = "whitespace-nowrap border-b border-line bg-panel px-3 py-2 text-left text-xs font-medium text-slate";
  const td = "border-b border-line px-3 py-2.5 align-top";
  const cols = 5 + (showRoute ? 1 : 0) + (selectable ? 1 : 0) + (compare ? 1 : 0);
  return (
    <div className="scroll-x rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse text-left" style={{ minWidth: compare ? 1080 : 900 }}>
        <caption className="sr-only">Requests, newest first</caption>
        <thead className="sticky top-0 z-10">
          <tr>
            {selectable && (
              <th scope="col" className={`${th} w-9`}>
                <Check on={!!allOnPage && rows.length > 0} onChange={() => onToggleAll?.()} label="Select every request shown" />
              </th>
            )}
            <th scope="col" className={`${th} w-[88px]`}>When</th>
            {showRoute && <th scope="col" className={`${th} w-[130px]`}>Route</th>}
            <th scope="col" className={th}>Request</th>
            <th scope="col" className={`${th} w-[170px]`}>Answered by</th>
            <th scope="col" className={`${th} w-[220px]`}>{compare ? name(compare[0]) : "Answer"}</th>
            {compare && <th scope="col" className={`${th} w-[220px]`}>{name(compare[1])}</th>}
            <th scope="col" className={`${th} w-[150px]`}>Labels</th>
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: loading }).map((_, i) => (
                <tr key={"s" + i}>
                  {Array.from({ length: cols }).map((__, j) => (
                    <td key={j} className={td}>
                      <span className="skel h-3" style={{ width: j % 2 ? "70%" : "90%" }} />
                    </td>
                  ))}
                </tr>
              ))
            : !rows.length
              ? (
                  <tr>
                    <td colSpan={cols} className="px-3 py-6 text-sm text-slate">
                      {empty}
                    </td>
                  </tr>
                )
              : rows.map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    onClick={() => onOpen(r)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(r))}
                    className={`cursor-pointer hover:bg-panel ${selected?.has(r.id) ? "bg-accent-soft/60" : ""} ${fresh?.has(r.id) ? "fresh" : ""}`}
                  >
                    {selectable && (
                      <td className={td}>
                        <Check on={selected!.has(r.id)} onChange={() => onToggle!(r.id)} label="Select this request" />
                      </td>
                    )}
                    <td className={`${td} whitespace-nowrap font-mono text-xs text-slate`} title={fmtT(r.t)}>
                      {ago(r.t)}
                    </td>
                    {showRoute && (
                      <td className={td}>
                        <span className="block truncate text-sm text-ink" title={r.route_name}>{r.route_name}</span>
                      </td>
                    )}
                    <td className={td}>
                      <Snippet r={r} />
                    </td>
                    <td className={td}>
                      <AnsweredCell r={r} name={name} />
                    </td>
                    <td className={td}>
                      <AnswersCell r={r} upstream={compare ? compare[0] : r.served} other={compare ? compare[1] : null} name={name} />
                    </td>
                    {compare && (
                      <td className={td}>
                        <AnswersCell r={r} upstream={compare[1]} other={compare[0]} name={name} />
                      </td>
                    )}
                    <td className={td}>
                      <LabelCell r={r} name={name} />
                    </td>
                  </tr>
                ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- one request, opened ---------- */

export function RequestView({
  r,
  name,
  narrow,
  onCorrect,
}: {
  r: Req;
  name: (id: string) => string;
  narrow: boolean;
  /** a person's pick for one question; label null clears it */
  onCorrect: (qid: string, label: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const ups = answeredBy(r);
  const qs = qids(r);
  const cv = chunkView(r);
  const steps = r.path?.steps || [];
  const run = async (q: string, label: string | null) => {
    setBusy(q);
    try {
      await onCorrect(q, label);
    } finally {
      setBusy(null);
    }
  };

  const labelCell = (q: string) => {
    const def = r.questions?.[q];
    const l = labelOf(r, q);
    const opts = optionsOf(def);
    return (
      <div className="min-w-0">
        {l.a ? <Answer def={def} a={l.a} /> : l.skip ? <span className="text-sm text-slate">unsure: not trained on</span> : <span className="text-sm text-slate">none yet</span>}
        <p className="text-2xs text-slate">{l.by === "person" ? "picked by you" : l.by ? `from ${name(l.by)}` : ""}</p>
        {opts.length > 0 && (
          <div className="mt-1.5">
            <Chips
              ariaLabel={`Label for ${q}`}
              disabled={busy !== null}
              options={[...opts.map((o, i) => ({ value: labelValue(def, o, i), label: o })), { value: SKIP, label: "unsure", title: "Can't be answered from this state; not trained on" }]}
              value={l.skip ? SKIP : l.by === "person" ? l.raw : null}
              onSelect={(v) => run(q, v)}
            />
            {l.by === "person" && (
              <QuietLink className="mt-1 text-xs" disabled={busy !== null} onClick={() => run(q, null)}>
                Remove the person's pick
              </QuietLink>
            )}
            {busy === q && <span className="ml-2 text-xs text-slate">saving…</span>}
          </div>
        )}
      </div>
    );
  };

  const useIt = (q: string, a: Ans | null) => {
    const l = labelOf(r, q);
    if (!a || (l.raw === a.answer && !l.skip)) return null;
    return (
      <QuietLink tone="accent" className="ml-1 text-xs" disabled={busy !== null} onClick={() => run(q, a.answer)} title="Make this answer the label for this question">
        use as label
      </QuietLink>
    );
  };

  return (
    <div className="min-w-0 space-y-4">
      <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Meta k="Route">
          <Link to={`/routes/${encodeURIComponent(r.route)}`} className="text-accent hover:underline">
            {r.route_name}
          </Link>
        </Meta>
        <Meta k="When">
          <span className="font-mono">{fmtT(r.t)}</span> <span className="text-slate">({ago(r.t)})</span>
        </Meta>
        <Meta k="Kind">{r.kind_name || "a kind of request"}</Meta>
        <Meta k="From">
          {sourceTag({ source: r.source as Source | null, via: r.via })}
          {r.holdout && <Badge className="ml-2">held out</Badge>}
        </Meta>
      </dl>

      <p className={`flex flex-wrap items-baseline gap-x-2 rounded border px-3 py-1.5 text-sm ${r.excluded ? "border-wait/40 bg-wait-soft" : "border-line"}`}>
        {r.excluded ? (
          <>
            <span className="text-ink">Left out of training: {leftOutWhy(r)}</span>
            <QuietLink tone="accent" disabled={busy !== null} onClick={() => run("__all__", null)} title="Train on this request with the rest">
              Include
            </QuietLink>
          </>
        ) : (
          <>
            <span className="text-slate">{r.holdout ? "Held out: used to measure models, never trained on." : "Trains with the rest of this route's requests."}</span>
            <QuietLink disabled={busy !== null} onClick={() => run("__all__", SKIP)} title="Keep this request out of training">
              Leave out
            </QuietLink>
          </>
        )}
        {busy === "__all__" && <span className="text-xs text-slate">saving…</span>}
      </p>

      <section>
        <h3 className="mb-1 text-sm font-semibold text-ink">State</h3>
        <StateBox state={r.state} maxHeight={220} />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold text-ink">Path</h3>
        {r.waited_ms != null && (
          <p className="mb-1 text-sm text-ink">
            The caller waited <span className="font-mono">{fmtMs(r.waited_ms)}</span>
            {r.served && r.ms?.[r.served] != null ? (
              <span className="text-slate">
                {" "}
                · {servedName(r, name)} took {fmtMs(r.ms[r.served])}
                {steps.length > 1 ? `${pathText(r, name) ? ", after the steps before it" : ""}` : ""}
              </span>
            ) : null}
            .
          </p>
        )}
        {steps.length ? (
          <ol className="space-y-1 text-sm">
            {steps.map((s, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                <span className="w-5 font-mono text-xs text-slate">{i + 1}</span>
                <span className="text-ink">{name(s.ask)}</span>
                <span className={s.ok && s.ask === r.served ? "text-go" : s.ok ? "text-slate" : "text-wait"}>
                  {s.ok && s.ask === r.served
                    ? "answered, served"
                    : `${REASON[s.reason || ""] || (s.ok ? "answered, passed over" : "failed")}${s.reason === "unsure" && s.conf != null ? ` (least sure ${pct(s.conf)})` : ""}${s.code ? ` · HTTP ${s.code}` : ""}`}
                </span>
                {s.ms != null && <span className="font-mono text-xs text-slate">{fmtMs(s.ms)}</span>}
              </li>
            ))}
            {!!r.path?.background?.length && (
              <li className="pl-7 text-slate">Also asked after the reply: {r.path.background.map(name).join(", ")}</li>
            )}
          </ol>
        ) : (
          <p className="text-sm text-slate">
            {r.served ? `${servedName(r, name)} answered${r.ms?.[r.served] != null ? ` in ${fmtMs(r.ms[r.served])}` : ""}.` : "Not answered."} {r.source !== "traffic" ? "Added outside a key, so no path was recorded." : ""}
          </p>
        )}
      </section>

      {cv && (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-ink">Word by word</h3>
          <div className="space-y-2">
            {ups.map((u) => (
              <div key={u}>
                <p className="mb-0.5 flex flex-wrap gap-x-2 text-xs text-slate">
                  <span className="text-ink">{u === keyOf(r, r.served) ? servedName(r, name) : name(u)}</span>
                  <ChunkCounts r={r} upstream={u} palette={cv.palette} />
                </p>
                <div className="rounded border border-line bg-surface px-3 py-2">
                  <ChunkLine r={r} v={cv} clamp={false} pick={(id) => answerOf(r, u, id)?.answer ?? null} against={(id) => labelOf(r, id).raw} />
                </div>
              </div>
            ))}
            <div>
              <p className="mb-0.5 text-xs font-medium text-ink">Labels{r.labels_from ? ` · from ${name(r.labels_from)}` : ""}</p>
              {qs.some((q) => labelOf(r, q).raw != null) ? (
                <div className="rounded border border-line bg-surface px-3 py-2">
                  <ChunkLine r={r} v={cv} clamp={false} pick={(id) => labelOf(r, id).raw} />
                </div>
              ) : (
                <p className="text-sm text-slate">None yet: nobody the route counts as right has answered it. Ask one from Requests, or pick words below.</p>
              )}
            </div>
            <p className="text-2xs text-slate">Outlined red: differs from the label. Fix single words in the table below.</p>
          </div>
        </section>
      )}

      <details open={!cv || qs.length <= 12} className="group">
      <summary className="mb-1 cursor-pointer list-none text-sm font-semibold text-ink">
          {cv ? `Every word, one per row (${qs.length})` : "Answers"} <span className="font-normal text-slate">· {ups.length ? `${ups.length} upstream${ups.length === 1 ? "" : "s"}` : "none yet"}</span>
          {cv && <span className="ml-2 text-xs font-normal text-accent group-open:hidden">show</span>}
      </summary>
        {narrow ? (
          <ul className="space-y-2">
            {qs.map((q) => (
              <li key={q} className="rounded-lg border border-line p-3">
                <QName q={q} r={r} />
                <dl className="mt-2 space-y-2 text-sm">
                  {ups.map((u) => (
                    <div key={u}>
                      <dt className="text-xs text-slate">
                        {name(u)}
                        {r.ms?.[u] != null ? ` · ${fmtMs(r.ms[u])}` : ""}
                      </dt>
                      <dd>
                        <Answer def={r.questions?.[q]} a={answerOf(r, u, q)} all />
                        {useIt(q, answerOf(r, u, q))}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-xs font-medium text-ink">Label</dt>
                    <dd>{labelCell(q)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <div className="scroll-x rounded-lg border border-line">
            <table className="w-full border-collapse text-left" style={{ minWidth: 240 + (ups.length + 1) * 220 }}>
              <thead>
                <tr className="bg-panel text-xs text-slate">
                  <th scope="col" className="border-b border-line px-3 py-1.5 font-medium">Question</th>
                  {ups.map((u) => (
                    <th key={u} scope="col" className="border-b border-line px-3 py-1.5 align-top font-medium">
                      <span className="block text-ink">{u === keyOf(r, r.served) ? servedName(r, name) : name(u)}</span>
                      <span className="font-normal">
                        {u === keyOf(r, r.served) ? "served" : "also answered"}
                        {r.ms?.[u] != null ? ` · ${fmtMs(r.ms[u])}` : ""}
                      </span>
                    </th>
                  ))}
                  <th scope="col" className="border-b border-line px-3 py-1.5 align-top font-medium">Label</th>
                </tr>
              </thead>
              <tbody>
                {qs.map((q) => (
                  <tr key={q} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-3 py-2 align-top font-normal">
                      <QName q={q} r={r} />
                    </th>
                    {ups.map((u) => (
                      <td key={u} className="px-3 py-2 align-top">
                        <Answer def={r.questions?.[q]} a={answerOf(r, u, q)} all />
                        {useIt(q, answerOf(r, u, q))}
                      </td>
                    ))}
                    <td className="px-3 py-2 align-top">{labelCell(q)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}

function Meta({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-12 shrink-0 text-slate">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function QName({ q, r }: { q: string; r: Req }) {
  const d = r.questions?.[q];
  return (
    <div className="min-w-0">
      <code className="font-mono text-sm text-ink">{q}</code>
      {d?.instructions && <p className="mt-0.5 text-xs text-slate">{d.instructions}</p>}
    </div>
  );
}

/** One request as the export writes it, for a selection made of picked rows. */
export const exportLine = (r: Req) => JSON.stringify({ state: r.state, questions: r.questions, labels: r.labels, answers: r.answers });

export const displayQ = (qs: Questions, q: string, raw: string) => displayAnswer(qs[q], raw);

/** One request in the side drawer, with a person's fixes saved as they are picked. */
export function RequestDrawer({ r, onClose, onPatched, name, narrow, onStep }: {
  r: Req | null; onClose: () => void; onPatched: (r: Req) => void; name: (id: string) => string; narrow: boolean;
  /** next (+1) or previous (-1) request in the list; with it, the keyboard labels: 1-9 pick an answer and move on */
  onStep?: (d: 1 | -1) => void;
}) {
  const toast = useToast();
  // Getting started: "See who answered" is ticked once this person has opened a request
  useEffect(() => {
    if (r) markRequestOpened();
  }, [r]);
  const correct = async (qid: string, label: string | null) => {
    if (!r) return;
    try {
      await correctRequest(r.route, { id: r.id, qid, label });
      // __all__: __skip__ leaves the whole request out of training, null brings it back (a person's include beats the realism check)
      if (qid === "__all__") return onPatched({ ...r, excluded: label === SKIP, left_out: label === SKIP ? "person" : null });
      const corrections = { ...(r.corrections || {}) };
      if (label == null) delete corrections[qid];
      else corrections[qid] = { label, t: Date.now() / 1000 };
      onPatched({ ...r, corrections });
    } catch (e) {
      toast.show((e as Error).message, "error");
      throw e;
    }
  };
  // Labelling from the keyboard: the first question you haven't picked yet takes the key; when every question has your pick,
  // the next request opens. 1-9: that answer, u: unsure, j / k (or the arrow keys): next / previous.
  const qs = r ? qids(r) : [];
  const target = r ? qs.find((q) => labelOf(r, q).by !== "person" && !labelOf(r, q).skip) ?? qs[0] : null;
  useEffect(() => {
    if (!r || !onStep) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); onStep(1); return; }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); onStep(-1); return; }
      if (!target) return;
      const def = r.questions?.[target], opts = optionsOf(def), n = Number(e.key);
      const label = e.key === "u" ? SKIP : Number.isInteger(n) && n >= 1 && n <= opts.length ? labelValue(def, opts[n - 1], n - 1) : null;
      if (label == null) return;
      e.preventDefault();
      const rest = qs.filter((q) => q !== target && labelOf(r, q).by !== "person" && !labelOf(r, q).skip);
      void correct(target, label).then(() => { if (!rest.length) onStep(1); }, () => {});
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const keysHint = r && onStep && target ? (
    <span className="text-xs text-slate">
      Keys: {optionsOf(r.questions?.[target]).slice(0, 9).map((o, i) => `${i + 1} ${o}`).join(" · ")} · u unsure · j/k next/previous
    </span>
  ) : null;
  return (
    <Drawer
      wide
      open={!!r}
      onClose={onClose}
      title={r ? `Request on ${r.route_name}` : ""}
      subtitle={r ? `${r.kind_name || "a kind of request"} · ${fmtT(r.t)}` : undefined}
      footer={
        r && (
          <>
            <LinkButton size="sm" to={`/routes/${encodeURIComponent(r.route)}/try?from=${encodeURIComponent(r.id)}`}>
              Try it again
            </LinkButton>
            <LinkButton size="sm" variant="quiet" to={`/routes/${encodeURIComponent(r.route)}`}>
              Open {r.route_name}
            </LinkButton>
            {keysHint}
            <Button size="sm" variant="primary" className="ml-auto" onClick={onClose}>
              Done
            </Button>
          </>
        )
      }
    >
      {r && (
        <RequestView
          r={r}
          name={name}
          narrow={narrow}
          onCorrect={(qid, label) => correct(qid, label).catch(() => {})}
        />
      )}
    </Drawer>
  );
}
