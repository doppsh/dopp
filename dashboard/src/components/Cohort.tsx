/* Which requests train the next version: by where they came from, key, kind, date and "only disagreements". Every
   request can train; this picks the batch. The count comes from the requests list itself (what matches, before the
   trainer skips held-out and left-out ones and ones without a label); the price comes from the server's estimate. */
import { useEffect, useMemo, useState } from "react";
import { fetchExamples } from "../lib/api";
import { num, SOURCES, setName } from "../lib/domain";
import type { Cohort, QuestionSet, Source } from "../lib/types";

export const ALL: Cohort = { labelled_only: true };

export const isAll = (c: Cohort) =>
  !c.sources?.length && !c.keys?.length && !c.schemas?.length && c.since == null && c.until == null && !c.disagreements_only;

const day = (t?: number | null) => (t == null ? "" : new Date(t * 1000).toISOString().slice(0, 10));
const secs = (d: string, end = false) => (d ? Math.floor(new Date(d + (end ? "T23:59:59" : "T00:00:00")).getTime() / 1000) : null);

/** How many requests match, counted from GET /examples (one call per source × key × kind picked, capped). null = too many combinations. */
export function useCohortCount(projectId: string, c: Cohort): number | null | undefined {
  const [n, setN] = useState<number | null | undefined>(undefined);
  const key = JSON.stringify(c);
  useEffect(() => {
    const srcs: (string | null)[] = c.sources?.length ? c.sources : [null];
    const combos: { source: string | null; key: string | null; schema: string | null }[] = [];
    for (const s of srcs)
      for (const k of s === "traffic" && c.keys?.length ? c.keys : [null])
        for (const sc of c.schemas?.length ? c.schemas : [null]) combos.push({ source: s, key: k ? `key ${k}` : null, schema: sc });
    // keys only narrow your app's requests: with no source picked, the other sources count in full
    if (!c.sources?.length && c.keys?.length) {
      combos.length = 0;
      for (const sc of c.schemas?.length ? c.schemas : [null]) {
        for (const k of c.keys) combos.push({ source: "traffic", key: `key ${k}`, schema: sc });
        for (const s of SOURCES.filter((x) => x.key !== "traffic")) combos.push({ source: s.key, key: null, schema: sc });
      }
    }
    if (combos.length > 16) {
      setN(null);
      return;
    }
    let live = true;
    setN(undefined);
    const t = setTimeout(() => {
      Promise.all(
        combos.map((x) => {
          const q = new URLSearchParams({ limit: "1", offset: "0" });
          if (x.source) q.set("source", x.source);
          if (x.key) q.set("key", x.key);
          if (x.schema) q.set("schema", x.schema);
          if (c.since != null) q.set("since", String(c.since));
          if (c.until != null) q.set("until", String(c.until));
          if (c.disagreements_only) q.set("disagree", "1");
          return fetchExamples(projectId, q.toString()).then((r) => r.total);
        }),
      )
        .then((xs) => live && setN(xs.reduce((a, b) => a + b, 0)))
        .catch(() => live && setN(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key]);
  return n;
}

function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-sm transition-colors ${on ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink hover:border-slate"}`}
    >
      {children}
    </button>
  );
}

export function CohortPicker({
  projectId,
  value,
  onChange,
  sets,
  keys,
  counts,
  modelLabel,
  hasVersion,
}: {
  projectId: string;
  value: Cohort;
  onChange: (c: Cohort) => void;
  sets: QuestionSet[];
  keys: string[];
  counts: Partial<Record<Source, number>>;
  modelLabel: string;
  hasVersion: boolean;
}) {
  const n = useCohortCount(projectId, value);
  const toggle = <T,>(xs: T[] | undefined, x: T) => (xs?.includes(x) ? xs.filter((y) => y !== x) : [...(xs || []), x]);
  const showKeys = keys.length > 1 && (!value.sources?.length || value.sources.includes("traffic"));
  const rowCls = "flex flex-wrap items-center gap-x-2 gap-y-1.5";
  const label = "w-[92px] shrink-0 text-sm text-slate";
  const summary = useMemo(() => (isAll(value) ? "every request" : "the requests picked below"), [value]);

  return (
    <div className="space-y-2.5">
      <div className={rowCls}>
        <span className={label}>From</span>
        <Chip on={!value.sources?.length} onClick={() => onChange({ ...value, sources: [] })}>
          anywhere
        </Chip>
        {SOURCES.filter((s) => counts[s.key]).map((s) => (
          <Chip key={s.key} on={!!value.sources?.includes(s.key)} title={s.hint} onClick={() => onChange({ ...value, sources: toggle(value.sources, s.key) })}>
            {s.label} <span className="font-mono text-xs opacity-70">{num(counts[s.key] || 0)}</span>
          </Chip>
        ))}
      </div>
      {showKeys && (
        <div className={rowCls}>
          <span className={label}>Keys</span>
          <Chip on={!value.keys?.length} onClick={() => onChange({ ...value, keys: [] })}>
            any key
          </Chip>
          {keys.map((k) => (
            <Chip key={k} on={!!value.keys?.includes(k)} onClick={() => onChange({ ...value, keys: toggle(value.keys, k) })}>
              <span className="font-mono">{k}…</span>
            </Chip>
          ))}
        </div>
      )}
      {sets.length > 1 && (
        <div className={rowCls}>
          <span className={label}>Kinds</span>
          <Chip on={!value.schemas?.length} onClick={() => onChange({ ...value, schemas: [] })}>
            every kind
          </Chip>
          {sets.map((s) => (
            <Chip key={s.id} on={!!value.schemas?.includes(s.id)} onClick={() => onChange({ ...value, schemas: toggle(value.schemas, s.id) })}>
              {setName(s)}
            </Chip>
          ))}
        </div>
      )}
      <div className={rowCls}>
        <span className={label}>Dates</span>
        <label className="flex items-center gap-1.5 text-sm text-slate">
          from
          <input type="date" className="rounded border border-line bg-surface px-2 py-0.5 text-sm text-ink" value={day(value.since)} onChange={(e) => onChange({ ...value, since: secs(e.target.value) })} />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate">
          to
          <input type="date" className="rounded border border-line bg-surface px-2 py-0.5 text-sm text-ink" value={day(value.until)} onChange={(e) => onChange({ ...value, until: secs(e.target.value, true) })} />
        </label>
      </div>
      {hasVersion && (
        <div className={rowCls}>
          <span className={label} />
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-slate">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--accent)]"
              checked={!!value.disagreements_only}
              onChange={(e) => onChange({ ...value, disagreements_only: e.target.checked })}
            />
            Only requests where {modelLabel} and Jev differ
          </label>
        </div>
      )}
      <p className="text-sm text-slate">
        Trains on {summary}:{" "}
        <b className="font-mono font-medium text-ink">{n === undefined ? "…" : n === null ? "?" : num(n)}</b> match. Held-out and left-out requests, and ones without Jev's
        answer or yours, are skipped.
        {!isAll(value) && (
          <button type="button" className="ml-2 text-accent hover:underline" onClick={() => onChange(ALL)}>
            Use every request
          </button>
        )}
      </p>
    </div>
  );
}
