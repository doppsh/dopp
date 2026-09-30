/* Add requests to a route without an app: paste your own rows, pull rows from a public dataset that reads like your
   requests, or have the generator write new ones anchored on your real requests. Every way names what it costs before it
   runs (from the route's own measured price per example, GET /credits), and says afterwards what was added and what was
   left out and why. Ported from the old app's "faucets". */
import { useEffect, useRef, useState } from "react";
import { Badge } from "./Badge";
import { Button, QuietLink } from "./Button";
import { EmptyState, Field, TextArea, TextInput } from "./Bits";
import {
  ApiError,
  findDatasets,
  generateRequests,
  parseRows,
  pasteRows,
  planRequests,
  refreshCredits,
  addDatasetRows,
} from "../lib/api";
import { bySize, chunkDef, isChunkSet, labelValue, num, optionsOf, pct, plural, priceFor, setName, stateText, timeFor, timeLeft } from "../lib/domain";
import { useProject } from "../lib/project";
import { createContext, useContext } from "react";
import { getSetup } from "../lib/api";
import { upstreamName } from "../lib/upstreams";
import type { Credits, DatasetCard, Dropped, IngestResult, ParseResult, Plan, QuestionSet } from "../lib/types";

export type AddTab = "paste" | "find" | "generate";
export const ADD_TABS: { id: AddTab; label: string; body: (who: string) => string }[] = [
  { id: "paste", label: "Paste", body: (w) => `Text, CSV, JSON or JSONL. ${w} answers each row; each becomes a request tagged pasted.` },
  { id: "find", label: "Find datasets", body: (w) => `Public datasets on Hugging Face that look like your requests, or one you name. You pick one; ${w} labels its rows.` },
  { id: "generate", label: "Generate", body: (w) => `New requests written from your real ones, each labelled by ${w}.` },
];
/** Who labels this route's added requests (its setup's first "who is right") and who checks realism and dataset fit. */
const Who = createContext<{ labeller: string; checker: string }>({ labeller: "you", checker: "Jev" });
function useWho(routeId: string) {
  const [w, setW] = useState<{ labeller: string; checker: string }>({ labeller: "you", checker: "Jev" });
  useEffect(() => {
    let on = true;
    getSetup(routeId).then((st) => { if (!on) return; const nm = (id: string) => st.answerers.find((a) => a.id === id)?.name || upstreamName(id, null);
      setW({ labeller: nm(st.setup.routes[0]?.oracle[0] || "you"), checker: nm(st.setup.checker || "jev") }); }).catch(() => {});
    const again = () => getSetup(routeId).then((st) => { if (!on) return; const nm = (id: string) => st.answerers.find((a) => a.id === id)?.name || upstreamName(id, null);
      setW({ labeller: nm(st.setup.routes[0]?.oracle[0] || "you"), checker: nm(st.setup.checker || "jev") }); }).catch(() => {});
    window.addEventListener("understudy:setup-saved", again);
    return () => { on = false; window.removeEventListener("understudy:setup-saved", again); };
  }, [routeId]);
  return w;
}

/** "#add-requests?tab=find" → "find". The anchor other pages link to. */
export function tabFromHash(hash: string): AddTab | null {
  if (!hash.startsWith("#add-requests")) return null;
  const t = new URLSearchParams(hash.split("?")[1] || "").get("tab");
  return t === "paste" || t === "find" || t === "generate" ? t : "paste";
}
export const addRequestsHref = (routeId: string, tab: AddTab) => `/routes/${encodeURIComponent(routeId)}#add-requests?tab=${tab}`;

/** What a link can pre-pick: "#add-requests?tab=generate&kind=<kind id>&aim=<qid=answer>&count=20" (the Training section's "Write 20"). */
export interface AddInit {
  kind?: string;
  aim?: string;
  count?: number;
}
export function addInitFromHash(hash: string): AddInit {
  if (!hash.startsWith("#add-requests")) return {};
  const q = new URLSearchParams(hash.split("?")[1] || "");
  const n = Number(q.get("count"));
  return { kind: q.get("kind") || undefined, aim: q.get("aim") || undefined, count: Number.isInteger(n) && n > 0 ? n : undefined };
}

function useCredits(routeId: string, bump = 0): Credits | null {
  const [c, setC] = useState<Credits | null>(null);
  useEffect(() => {
    let on = true;
    if (!bump) setC(null);
    refreshCredits(routeId).then((x) => on && setC(x));
    return () => {
      on = false;
    };
  }, [routeId, bump]);
  return c;
}

export function AddRequests({ routeId, tab, onTab, onAdded, init = {} }: { routeId: string; tab: AddTab; onTab: (t: AddTab) => void; onAdded?: () => void; init?: AddInit }) {
  const { data: proj, error } = useProject(routeId);
  const sets = proj?.question_sets || [];
  const meta = ADD_TABS.find((t) => t.id === tab)!;
  const who = useWho(routeId);
  return (
    <Who.Provider value={who}>
    <div>
      <div role="tablist" aria-label="Ways to add requests" className="flex flex-wrap gap-1 border-b border-line">
        {ADD_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${tab === t.id ? "border-accent text-ink" : "border-transparent text-slate hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-slate">{meta.body(who.labeller)}</p>
      <div className="mt-3" role="tabpanel">
        {error && !proj ? (
          <p className="text-sm text-stop">Couldn't load this route's kinds of requests: {error}</p>
        ) : !proj ? (
          <div className="space-y-2">
            <span className="skel h-4 w-1/3" />
            <span className="skel h-24 w-full" />
          </div>
        ) : !sets.length ? (
          <EmptyState
            title="This route has no kinds of requests yet."
            body="Send one request (from your app or Try a request) so we know its questions; then you can add more here."
          />
        ) : tab === "paste" ? (
          <Paste key={routeId + (init.kind || "")} routeId={routeId} sets={sets} onAdded={onAdded} init={init} />
        ) : tab === "find" ? (
          <Find key={routeId + (init.kind || "")} routeId={routeId} sets={sets} onAdded={onAdded} init={init} />
        ) : (
          <Generate key={[routeId, init.kind, init.aim, init.count].join("|")} routeId={routeId} sets={sets} onAdded={onAdded} init={init} />
        )}
      </div>
    </div>
    </Who.Provider>
  );
}

interface Props {
  routeId: string;
  sets: QuestionSet[];
  onAdded?: () => void;
  init?: AddInit;
}

/* ---------- shared bits ---------- */

function useSchema(sets: QuestionSet[], want?: string) {
  const [schema, setSchema] = useState(() => (want && sets.some((s) => s.id === want) ? want : bySize(sets)[0]?.id || ""));
  useEffect(() => {
    if (!sets.some((s) => s.id === schema) && sets[0]) setSchema(bySize(sets)[0].id);
  }, [sets, schema]);
  return [schema, setSchema] as const;
}

function SetPicker({ sets, value, onChange, id }: { sets: QuestionSet[]; value: string; onChange: (v: string) => void; id: string }) {
  const cur = sets.find((s) => s.id === value);
  if (sets.length === 1)
    return (
      <p className="text-sm text-slate">
        Kind of request: <b className="font-medium text-ink">{cur ? setName(cur) : "—"}</b>
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={id} className="text-slate">
        Kind of request
      </label>
      <select id={id} className="rounded border border-line bg-surface px-2 py-1 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {sets.map((s) => (
          <option key={s.id} value={s.id}>
            {setName(s)} · {num(s.readiness?.calls ?? 0)} requests
          </option>
        ))}
      </select>
    </div>
  );
}

const DROP_WHY: Record<string, string> = { format: "didn't match your format", realism: "didn't read like yours", duplicate: "already had it" };

function droppedParts(d?: number | Dropped): string[] {
  if (!d) return [];
  if (typeof d === "number") return [`${num(d)} dropped by the quality check`];
  return Object.entries(d)
    .filter(([, n]) => n)
    .map(([k, n]) => `${num(n as number)} dropped (${DROP_WHY[k] || k})`);
}

/** What happened: what was added, what was left out or dropped and why. */
function Outcome({ r, written }: { r: IngestResult; written?: boolean }) {
  const failed = r.failed || [];
  const added = r.recorded ?? r.added ?? 0;
  const rows = r.pulled ?? added;
  const field = r.plan?.seed_field;
  const head = written
    ? `${num(r.added ?? added)} added`
    : r.composed
      ? `${plural(rows, "row")} placed into ${field || "your state"} and written into your request format`
      : `${num(added)} added from ${plural(rows, "row")}`;
  const pending = r.pending || 0;
  const leftOut = r.left_out || 0;
  const tail = [
    leftOut ? `${num(leftOut)} left out of training because Jev thought they didn't read like your requests (they're in Requests; include any from its row)` : "",
    pending ? `${num(pending)} saved without an answer: label them on the Requests page (open one, then 1-9 picks an answer and moves on)` : "",
    ...droppedParts(r.dropped),
    failed.length && !pending ? `${num(failed.length)} failed` : "",
  ].filter(Boolean);
  return (
    <div className={`mt-3 rounded border px-3 py-2 text-sm text-ink ${added ? "border-go/40 bg-go-soft" : "border-wait/40 bg-wait-soft"}`} role="status">
      <b className="font-medium">{head}</b>
      {tail.map((t) => " · " + t).join("")}
      {r.holdout ? <span className="text-slate"> · {num(r.holdout)} held out to measure versions</span> : null}
      {!!r.reasons?.length && (
        <ul className="mt-1 list-disc pl-5 text-xs text-slate">
          {r.reasons.slice(0, 5).map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {r.gate && r.gate.startsWith("skipped") && <p className="mt-1 text-xs text-slate">The "reads like yours" check was skipped: {r.gate.replace(/^skipped:\s*/, "")}</p>}
      {failed.length > 0 && !pending && (
        <ul className="mt-1 font-mono text-xs text-stop">
          {failed.slice(0, 3).map((f) => (
            <li key={f.i}>
              row {f.i + 1}: {f.error}
            </li>
          ))}
          {failed.length > 3 && <li>…and {failed.length - 3} more</li>}
        </ul>
      )}
    </div>
  );
}

function addUp(total: IngestResult, r: IngestResult) {
  total.recorded = (total.recorded || 0) + (r.recorded ?? r.added ?? 0);
  total.holdout += r.holdout || 0;
  total.pending = (total.pending || 0) + (r.pending || 0);
  total.left_out = (total.left_out || 0) + (r.left_out || 0);
  if (r.pulled != null) total.pulled = (total.pulled || 0) + r.pulled;
  total.composed = r.composed ?? total.composed;
  total.plan = r.plan ?? total.plan;
  if (r.dropped && typeof r.dropped === "object") {
    const d = (total.dropped && typeof total.dropped === "object" ? total.dropped : {}) as Dropped;
    for (const k of Object.keys(r.dropped) as (keyof Dropped)[]) d[k] = (d[k] || 0) + (r.dropped[k] || 0);
    total.dropped = d;
  } else if (typeof r.dropped === "number") total.dropped = ((typeof total.dropped === "number" ? total.dropped : 0) as number) + r.dropped;
  for (const x of r.reasons || []) if (!(total.reasons ||= []).includes(x)) total.reasons.push(x);
}

/** For kinds whose questions are one per word, one text is several requests to Jev. */
function jevRequests(set: QuestionSet | undefined, states: unknown[]): number {
  if (!isChunkSet(set)) return states.length;
  return states.reduce<number>((n, s) => n + Math.max(1, Math.ceil(stateText(s).split(/\s+/).filter(Boolean).length / 40)), 0);
}

function PriceNote({ credits, written }: { credits: Credits | null; written?: boolean }) {
  const pe = credits?.per_example;
  if (pe?.label != null && (!written || pe.write != null)) return <>Price from what examples have cost on this route so far.</>;
  if (written && pe?.label != null) return <>Labelling is priced from this route's history; writing is estimated (about 200 tokens each way at the writer's list price) until the first batch is measured.</>;
  return <>No history on this route yet, so the price is an estimate: about 200 tokens per request at list price{written ? ", for Jev and for the writer" : ""}.</>;
}

/* ---------- Paste ---------- */

const CHUNK = 50;

function Paste({ routeId, sets, onAdded, init }: Props) {
  const { labeller } = useContext(Who);
  const credits = useCredits(routeId);
  const [schema, setSchema] = useSchema(sets, init?.kind);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const startedAt = useRef(0);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function parse(src = text, column?: string) {
    if (!src.trim()) return;
    setParsing(true);
    setErr(null);
    if (!column) setParsed(null);
    setResult(null);
    try {
      setParsed(await parseRows(routeId, src, column));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setParsing(false);
    }
  }

  async function label() {
    if (!parsed) return;
    const states = parsed.states;
    setErr(null);
    setResult(null);
    const total: IngestResult = { recorded: 0, holdout: 0, failed: [] };
    startedAt.current = Date.now();
    setProgress({ done: 0, total: states.length });
    try {
      for (let i = 0; i < states.length; i += CHUNK) {
        const r = await pasteRows(routeId, { schema, states: states.slice(i, i + CHUNK) });
        addUp(total, r);
        for (const f of r.failed || []) total.failed!.push({ i: f.i + i, error: f.error });
        setProgress({ done: Math.min(states.length, i + CHUNK), total: states.length });
      }
      if (total.pulled === undefined) total.pulled = states.length;
      setResult(total);
      setParsed(null);
      setText("");
      setFileName(null);
      onAdded?.();
    } catch (e) {
      setErr((e as Error).message + (total.recorded ? ` (${num(total.recorded)} were added before this.)` : ""));
      if (total.recorded) onAdded?.();
    } finally {
      setProgress(null);
    }
  }

  const n = parsed?.states.length ?? 0;
  const set = sets.find((s) => s.id === schema);
  const chunky = isChunkSet(set);
  const reqs = parsed ? jevRequests(set, parsed.states) : 0;

  return (
    <div>
      <SetPicker sets={sets} value={schema} onChange={setSchema} id="add-p-set" />
      <div className="mt-3">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="add-p-text" className="text-base font-medium text-ink">
            {chunky ? "Texts" : "Requests"} <span className="font-normal text-slate">· one per line, CSV, JSON or JSONL</span>
          </label>
          <span className="flex items-center gap-2 text-sm">
            {fileName && <span className="font-mono text-xs text-slate">{fileName}</span>}
            <QuietLink tone="accent" onClick={() => fileRef.current?.click()}>
              Choose a file
            </QuietLink>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv,.tsv,.json,.jsonl,.ndjson,text/*,application/json"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const t = await f.text();
                setFileName(`${f.name} · ${Math.round(f.size / 1024)} KB`);
                setText(t);
                parse(t);
                e.target.value = "";
              }}
            />
          </span>
        </div>
        <TextArea
          id="add-p-text"
          rows={7}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setParsed(null);
          }}
          placeholder={"Where is my order? It's been two weeks.\nThe lid was cracked when it arrived.\n…"}
        />
      </div>
      {!parsed && (
        <Button className="mt-2" loading={parsing} disabled={!text.trim()} onClick={() => parse()}>
          Read the rows
        </Button>
      )}
      {parsed && (
        <div className="mt-3">
          <p className="text-sm text-slate">
            Found <b className="font-mono text-ink">{num(n)}</b> {chunky ? (n === 1 ? "text" : "texts") : n === 1 ? "request" : "requests"} as{" "}
            <span className="font-mono">{parsed.format}</span>
            {parsed.column ? (
              (parsed.columns?.length || 0) > 1 ? (
                <>
                  , text from column{" "}
                  <select
                    aria-label="Text column"
                    className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs"
                    value={parsed.column}
                    disabled={parsing}
                    onChange={(e) => parse(text, e.target.value)}
                  >
                    {parsed.columns!.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {parsed.picked_by && parsed.picked_by !== "you" ? <span> (picked by {parsed.picked_by})</span> : null}
                </>
              ) : (
                <>
                  , text from column <code className="font-mono text-ink">{parsed.column}</code>
                </>
              )
            ) : null}
            . First {Math.min(5, n)}:
          </p>
          <ol className="mt-1.5 divide-y divide-line rounded border border-line bg-surface">
            {parsed.states.slice(0, 5).map((s, i) => (
              <li key={i} className="grid grid-cols-[24px_1fr] gap-2 px-3 py-1.5 text-sm">
                <span className="font-mono text-xs text-slate">{i + 1}</span>
                <span className="clamp-2 min-w-0 break-words">{stateText(s)}</span>
              </li>
            ))}
          </ol>
          {n > 1000 && <p className="mt-2 text-sm text-wait">That's more than 1,000; they go in batches of {CHUNK}, which takes a while.</p>}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={!n || !!progress} onClick={label}>
              {progress
                ? `${labeller} answered ${num(progress.done)} of ${num(progress.total)}…${timeLeft(startedAt.current, progress.done, progress.total)}`
                : `Ask ${labeller} about ${num(n)} · ${priceFor(reqs, credits, chunky)} · ${timeFor(reqs, chunky)}`}
            </Button>
            <QuietLink onClick={() => setParsed(null)}>Edit the text</QuietLink>
          </div>
          <p className="mt-1 text-xs text-slate">
            {chunky ? `${plural(reqs, "request")} to ${labeller} (the words are sent in batches, like your app does). ` : ""}
            <PriceNote credits={credits} /> One in ten is held out to measure versions.
          </p>
        </div>
      )}
      {err && <p className="mt-2 text-sm text-stop">Couldn't finish: {err}</p>}
      {result && <Outcome r={result} />}
    </div>
  );
}

/* ---------- Find datasets ---------- */

function Find({ routeId, sets, onAdded, init }: Props) {
  const { checker } = useContext(Who);
  const [schema, setSchema] = useSchema(sets, init?.kind);
  const [cards, setCards] = useState<DatasetCard[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = sets.find((s) => s.id === schema);

  async function search() {
    setBusy(true);
    setErr(null);
    setCards(null);
    try {
      setCards(await findDatasets(routeId, schema, q.trim() || undefined));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <SetPicker
          sets={sets}
          value={schema}
          onChange={(v) => {
            setSchema(v);
            setCards(null);
          }}
          id="add-f-set"
        />
        <input
          id="add-f-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          placeholder="words to search for, or a dataset (owner/name)"
          className="min-w-[16rem] flex-1 rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink placeholder:text-slate"
        />
        <Button variant={cards ? "secondary" : "primary"} loading={busy} onClick={search}>
          {q.trim() ? "Search" : cards ? "Search again" : "Search Hugging Face for datasets like your requests"}
        </Button>
      </div>
      <p className="mt-1 text-sm text-slate">
        Searches public datasets by this kind of request (or the words or dataset you type), then {checker} scores a few rows of each for fit. Scoring isn't saved as requests.
      </p>
      {err && <p className="mt-2 text-sm text-stop">Couldn't search datasets: {err}</p>}
      {busy && (
        <p className="mt-3 text-sm text-slate" aria-live="polite">
          Searching and scoring samples. This usually takes 10–30 seconds.
        </p>
      )}
      {cards && cards.length === 0 && (
        <div className="mt-3">
          <EmptyState title="No public datasets fit these questions." body="Try Paste with your own rows, or Generate requests written to match the ones you have." />
        </div>
      )}
      {cards && cards.length > 0 && (
        <ul className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 xl:grid-cols-2">
          {cards.map((c) => (
            <DatasetItem key={c.id} c={c} routeId={routeId} schema={schema} written={isChunkSet(set)} onAdded={onAdded} />
          ))}
        </ul>
      )}
    </div>
  );
}

const USE_MAX = 500;

function DatasetItem({ c, routeId, schema, written, onAdded }: { c: DatasetCard; routeId: string; schema: string; written: boolean; onAdded?: () => void }) {
  const { labeller, checker } = useContext(Who);
  const cols = [...new Set([c.column, ...(c.columns || [])].filter(Boolean) as string[])];
  const credits = useCredits(routeId);
  const [column, setColumn] = useState(cols[0] || "");
  const [count, setCount] = useState(Math.min(c.rows || USE_MAX, 50));
  const [startText, setStartText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  // where this route is in the dataset, remembered server-side
  const [used, setUsed] = useState(c.next_row || 0);
  const [progress, setProgress] = useState<{ done: number; of: number; added: number } | null>(null);
  const startedAt = useRef(0);
  const n = Math.max(1, Math.min(count || 0, c.rows || USE_MAX, USE_MAX));

  async function run() {
    setBusy(true);
    setErr(null);
    setResult(null);
    const STEP = 5; // small steps so a slow moment can't time the whole thing out, and progress moves
    const total: IngestResult = { recorded: 0, holdout: 0, failed: [], pulled: 0, reasons: [] };
    let offset = used,
      done = 0;
    startedAt.current = Date.now();
    try {
      while (done < n) {
        const take = Math.min(STEP, n - done);
        setProgress({ done, of: n, added: total.recorded || 0 });
        const r = await addDatasetRows(routeId, { dataset: c.id, column, count: take, schema, config: c.config, split: c.split, offset: offset || undefined });
        const pulled = r.pulled ?? take;
        addUp(total, { ...r, pulled });
        offset += pulled;
        done += take;
        setUsed(offset);
        if (!pulled) break; // the dataset ran out
      }
      setResult(total);
      onAdded?.();
    } catch (e) {
      setErr((e as Error).message + (done ? ` (${num(total.recorded || 0)} added before that; the rest weren't started)` : ""));
      if (done) {
        setResult(total);
        onAdded?.();
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <li className="flex min-w-0 flex-col rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <a href={c.url} target="_blank" rel="noopener" className="min-w-0 break-words font-mono text-sm font-medium text-accent hover:underline">
          {c.name} ↗
        </a>
        <Badge tone={c.fit >= 0.7 ? "go" : c.fit >= 0.4 ? "wait" : "neutral"} mono title={`How much its rows read like this route's requests, scored by ${checker}`}>
          fit {pct(c.fit)}
        </Badge>
      </div>
      <p className="mt-0.5 text-xs text-slate">
        <span className="font-mono">{num(c.rows)}</span> rows{c.used_rows ? ` · ${num(c.used_rows)} used already` : ""}
        {c.description ? ` · ${c.description}` : ""}
      </p>
      {c.reason && <p className="mt-1 text-sm text-slate">{c.reason.replace(/; could inform \{chunk\}/, "").replace(/could inform \{chunk\}/, "could inform your questions")}</p>}
      <ul className="mt-2 space-y-1">
        {c.sample.slice(0, 3).map((s, i) => (
          <li key={i} className="clamp-2 rounded bg-panel px-2 py-1 text-xs text-ink">
            {s}
          </li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-sm">
        {cols.length > 1 && (
          <select aria-label="Text column" className="rounded border border-line bg-surface px-2 py-1 text-sm" value={column} onChange={(e) => setColumn(e.target.value)}>
            {cols.map((col) => (
              <option key={col} value={col}>
                column {col}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-slate">
          start at row
          <input
            type="number"
            min={1}
            max={c.rows || undefined}
            value={startText ?? String(used + 1)}
            onChange={(e) => {
              setStartText(e.target.value);
              if (e.target.value !== "") setUsed(Math.max(0, (Number(e.target.value) || 1) - 1));
            }}
            onBlur={() => setStartText(null)}
            className="w-24 rounded border border-line bg-surface px-2 py-1 font-mono text-sm"
          />
        </label>
        <label className="flex items-center gap-1.5 text-slate">
          rows
          <input
            type="number"
            min={1}
            max={Math.min(c.rows || USE_MAX, USE_MAX)}
            value={count || ""}
            onChange={(e) => setCount(e.target.value === "" ? 0 : Number(e.target.value))}
            className="w-20 rounded border border-line bg-surface px-2 py-1 font-mono text-sm"
          />
        </label>
      </div>
      <Button className="mt-2" size="sm" variant="primary" disabled={busy || (!!c.rows && used >= c.rows)} onClick={run}>
        {`Add rows ${num(used + 1)}–${num(Math.min(used + n, c.rows || used + n))} · ${labeller} labels them · ${priceFor(n, credits, written)} · ${timeFor(n, written)}`}
      </Button>
      <p className="mt-1 text-xs text-slate">
        <PriceNote credits={credits} />
      </p>
      {progress && (
        <div className="mt-2 text-xs text-slate" role="status" aria-live="polite">
          <div className="flex h-1.5 w-full overflow-hidden rounded bg-line">
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round((100 * progress.done) / Math.max(1, progress.of))}%` }} />
          </div>
          <p className="mt-1 font-mono">
            Asking {labeller} about rows {num(progress.done + 1)}–{num(Math.min(progress.of, progress.done + 5))} of {num(progress.of)}… · {num(progress.added)} added
            {timeLeft(startedAt.current, progress.done, progress.of)}
          </p>
        </div>
      )}
      {err && <p className="mt-2 text-sm text-stop">{err}</p>}
      {result && !progress && <Outcome r={result} />}
    </li>
  );
}

/* ---------- Generate ---------- */

const GEN_MAX = 50;

function Generate({ routeId, sets, onAdded, init }: Props) {
  const { labeller, checker } = useContext(Who);
  const [batches, setBatches] = useState(0);   // re-price after each batch: the first one turns the estimate into a measured price
  const credits = useCredits(routeId, batches);
  const [schema, setSchema] = useSchema(sets, init?.kind);
  const [count, setCount] = useState(Math.min(GEN_MAX, init?.count || 20));
  const [target, setTarget] = useState(init?.aim || "");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [plan, setPlan] = useState<{ plan: Plan | null; err: ApiError | Error | null; loading: boolean }>({ plan: null, err: null, loading: true });
  const set = sets.find((s) => s.id === schema);
  const defs = set?.question_defs || {};
  const chunky = isChunkSet(set);
  const targets = chunky
    ? optionsOf(set ? chunkDef(set) : undefined).map((o) => ({ value: `chunk=${o}`, label: `words that are ${o}` }))
    : Object.entries(defs).flatMap(([q, d]) => optionsOf(d).map((o, i) => ({ value: `${q}=${labelValue(d, o, i)}`, label: `${q} = ${o}` })));
  const n = Math.max(1, Math.min(GEN_MAX, count || 0));

  useEffect(() => {
    if (!schema) return;
    let on = true;
    const known = set?.plan?.summary ? set.plan : null;
    setPlan({ plan: known, err: null, loading: !known });
    if (known) return;
    planRequests(routeId, schema)
      .then((p) => on && setPlan({ plan: p, err: null, loading: false }))
      .catch((e) => on && setPlan({ plan: null, err: e as Error, loading: false }));
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, schema]);
  // No real requests yet (400) or no generator key on the server (503): nothing can be written.
  const status = plan.err instanceof ApiError ? plan.err.status : 0;
  const cantWrite = status === 400 || status === 503;

  async function run() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const i = target.indexOf("=");
      const r = await generateRequests(routeId, {
        schema,
        count: n,
        target: target && i > 0 ? { qid: target.slice(0, i), answer: target.slice(i + 1) } : undefined,
        prompt: hint.trim() || undefined,
      });
      setResult(r);
      onAdded?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setBatches((b) => b + 1);
    }
  }

  return (
    <div>
      <SetPicker sets={sets} value={schema} onChange={setSchema} id="add-g-set" />
      <div className="mt-2 rounded border border-line bg-panel px-3 py-2 text-sm">
        {plan.loading ? (
          <span className="text-slate">Reading your real requests to see what to write…</span>
        ) : plan.plan ? (
          <p className="text-ink">
            <span className="text-slate">What gets written: </span>
            {plan.plan.summary}
          </p>
        ) : plan.err ? (
          <p className={cantWrite ? "text-wait" : "text-stop"}>{plan.err.message}</p>
        ) : null}
      </div>
      {!cantWrite && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-4 sm:grid-cols-[140px_minmax(0,1fr)]">
            <Field label="How many" id="add-g-count" hint={`Up to ${GEN_MAX} at a time.`}>
              <TextInput id="add-g-count" type="number" min={1} max={GEN_MAX} value={count || ""} onChange={(e) => setCount(e.target.value === "" ? 0 : Number(e.target.value))} className="font-mono" />
            </Field>
            <Field label="Aim at an answer" id="add-g-target" hint={chunky ? "Optional. Writes texts with several words of this kind." : "Optional. Writes requests whose answer should be this one."}>
              <select id="add-g-target" className="w-full rounded border border-line bg-surface px-2.5 py-1.5 text-base" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Any answer (a spread like your requests)</option>
                {targets.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Hint" id="add-g-hint" hint="Optional. Anything the writer should know, e.g. “short, angry, mentions a tracking number”.">
            <TextInput id="add-g-hint" value={hint} onChange={(e) => setHint(e.target.value)} maxLength={300} />
          </Field>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="primary" loading={busy} disabled={plan.loading && !plan.plan} onClick={run}>
              Write {n} and label with {labeller} · {priceFor(n, credits, true)} · {timeFor(n, true)}
            </Button>
          </div>
          <p className="mt-1 text-xs text-slate">
            Written from up to 8 of your real requests. {labeller} answers each; {checker} checks them, and any that don't read like yours are dropped and counted below. <PriceNote credits={credits} written />
          </p>
        </>
      )}
      {busy && (
        <p className="mt-2 text-sm text-slate" aria-live="polite">
          Writing and checking {n} requests. Usually under a minute.
        </p>
      )}
      {err && <p className="mt-2 text-sm text-stop">Couldn't write requests: {err}</p>}
      {result && <Outcome r={result} written />}
    </div>
  );
}
