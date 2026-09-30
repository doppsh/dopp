/* One request, opened: rows are its questions; columns are every answer it got (who answered it first, then anyone
   asked alongside, then the in-browser model picked in "Compare with"), and "Trains on", the answer the next version
   learns: Jev's by default, or any answer (or your own) a person picks. Used on Requests (open row) and Try it. */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "./Badge";
import { QuietLink } from "./Button";
import { Chips } from "./Bits";
import { displayAnswer, fmtMs, fmtT, labelValue, needsReview, optionsOf, rawOf, sourceTag, targetName } from "../lib/domain";
import type { LayaLabels } from "../lib/layaWeb";
import type { Ans, Example as Ex, Questions } from "../lib/types";

export const SKIP = "__skip__";

/** An in-browser answerer's column: not loaded yet, scoring, or answered. */
export type LayaCell = LayaLabels | "pending" | "unloaded" | undefined;

/** The one comparison picked in "Compare with": the recorded answers of your model, or a model running in this browser. */
export type Compare = { key: string; name: string; cell?: LayaCell } | null;

/* ---------- what each column says, as raw labels ---------- */

/** The answer a request trains on for one question: your pick, else the labeller's answer. A request only your model answered has
    no grounded answer yet: its model answer is returned as `provisional` (what was served, not something to train on). */
export function labelOf(ex: Ex, q: string): { raw: string | null; skip: boolean; corrected: boolean; provisional?: boolean } {
  const cr = ex.corrections?.[q];
  if (cr) return cr.label === SKIP ? { raw: null, skip: true, corrected: true } : { raw: String(cr.label), skip: false, corrected: true };
  const j = ex.jev?.[q];
  if (j) return { raw: String(j.answer), skip: false, corrected: false };
  const m = ex.local?.[q];
  return m != null ? { raw: String(m), skip: false, corrected: false, provisional: true } : { raw: null, skip: false, corrected: false };
}

export function servedOf(ex: Ex): string {
  if (ex.served) return ex.served;
  if (ex.model && ex.model.startsWith("understudy/")) return "model";
  if (ex.model && ex.model.startsWith("endpoint:")) return ex.model;
  return "jev";
}

export function modelOf(ex: Ex, q: string): Ans | null {
  const full = rawOf(ex.answers?.model?.[q]);
  if (full) return full;
  const l = ex.local?.[q];
  return l != null ? { answer: String(l) } : null;
}

/** One target's recorded answer to one question. */
export function answerOf(ex: Ex, target: string, q: string): Ans | null {
  if (target === "jev") return ex.jev?.[q] ? rawOf(ex.jev[q]) : rawOf(ex.answers?.jev?.[q]);
  if (target === "model") return modelOf(ex, q);
  return rawOf(ex.answers?.[target]?.[q]);
}

/** Every target that answered this request, the one that answered it first. */
export function targetsOf(ex: Ex): string[] {
  const served = servedOf(ex);
  const have = new Set(Object.keys(ex.answers || {}).filter((k) => ex.answers?.[k] && Object.keys(ex.answers[k]!).length));
  if (ex.jev && Object.keys(ex.jev).length) have.add("jev");
  if (ex.local && Object.keys(ex.local).length) have.add("model");
  return [...(have.has(served) ? [served] : []), ...[...have].filter((k) => k !== served).sort((a, b) => (a === "jev" ? -1 : b === "jev" ? 1 : a.localeCompare(b)))];
}

/** The compared answer for one question, or null when there's nothing to compare. */
export function compareOf(ex: Ex, q: string, c: Compare): Ans | null {
  if (!c) return null;
  if (c.key === "recorded") return modelOf(ex, q);
  const cell = c.cell;
  return cell && typeof cell === "object" && cell[q] ? { answer: cell[q].label, p: cell[q].p, dist: cell[q].dist } : null;
}

/** 1 when the compared answer differs from what the request trains on, else 0. */
export function misses(ex: Ex, q: string, c: Compare): number {
  const { raw, provisional } = labelOf(ex, q);
  if (raw == null || provisional) return 0;
  const a = compareOf(ex, q, c);
  return a && a.answer !== raw ? 1 : 0;
}

/* ---------- the matrix ---------- */

export interface ExampleProps {
  ex: Ex;
  defs: Questions;
  /** the model's name, so answers say "support-triage v2", not "v2" */
  modelLabel?: string | null;
  endpoints?: { target: string; name: string }[] | null;
  /** the in-browser model picked in "Compare with" (recorded answers are already columns) */
  compare?: Compare;
  narrow: boolean;
  /** false when the surrounding row already shows the full state */
  showState?: boolean;
  onCorrect: (qid: string, label: string | null) => Promise<void>;
  onLooksRight: () => Promise<void>;
}

export function ExampleMatrix({ ex, defs, modelLabel, endpoints, compare, narrow, showState = true, onCorrect, onLooksRight }: ExampleProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const served = servedOf(ex);
  const unreviewed = needsReview(ex);
  const nameOf = (tg: string) => targetName(tg, { model: modelLabel, v: ex.v, endpoints });

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  // a person can make any answer the one it trains on
  const useIt = (q: string, a: { answer: string } | null) => {
    const lab = labelOf(ex, q);
    if (!a || ex.excluded || (!lab.provisional && lab.raw === a.answer && !lab.skip)) return null;
    const isJev = ex.jev?.[q] && String(ex.jev[q].answer) === a.answer;
    return (
      <QuietLink
        tone="accent"
        disabled={busy !== null}
        className="ml-2 text-xs"
        title="Train on this answer for this question"
        onClick={() => run(q, () => onCorrect(q, isJev && lab.corrected ? null : a.answer))}
      >
        use
      </QuietLink>
    );
  };

  const cols: { key: string; header: ReactNode; cell: (q: string) => ReactNode }[] = [
    ...targetsOf(ex).map((tg) => ({
      key: tg,
      header: (
        <span className="flex flex-col">
          <span className="text-ink">{nameOf(tg)}</span>
          <span className="font-normal text-2xs text-slate">
            {tg === served ? "answered" : "also answered"}
            {ex.ms?.[tg] != null ? ` · ${fmtMs(ex.ms[tg])}` : ""}
          </span>
        </span>
      ),
      cell: (q: string) => {
        const a = answerOf(ex, tg, q);
        return (
          <>
            <Answer def={defs[q]} a={a} label={labelOf(ex, q)} />
            {useIt(q, a)}
          </>
        );
      },
    })),
    ...(compare && compare.key !== "recorded"
      ? [
          {
            key: "cmp",
            header: (
              <span className="flex flex-col">
                <span className="text-ink">{compare.name.replace(/ in this browser$/, "")}</span>
                <span className="font-normal text-2xs text-slate">in this browser</span>
              </span>
            ),
            cell: (q: string) => {
              const c = compare.cell;
              if (c === "pending") return <span className="skel h-3 w-20" />;
              if (c === "unloaded" || c === undefined) return <span className="text-xs text-slate">not loaded</span>;
              const a = compareOf(ex, q, compare);
              return (
                <>
                  <Answer def={defs[q]} a={a} label={labelOf(ex, q)} />
                  {useIt(q, a)}
                </>
              );
            },
          },
        ]
      : []),
  ];

  const chips = (q: string) => {
    const def = defs[q];
    const opts = optionsOf(def);
    const lab = labelOf(ex, q);
    const current = lab.skip ? SKIP : lab.provisional ? null : lab.raw;
    if (!opts.length) return <span className="text-sm text-slate">This question's options aren't loaded, so it can't be set here.</span>;
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chips
          ariaLabel={`Answer to train on for ${q}`}
          disabled={busy !== null || ex.excluded}
          options={[
            ...opts.map((o, i) => ({ value: labelValue(def, o, i), label: o })),
            { value: SKIP, label: "unsure", title: "Can't be answered from this state. This question won't be trained on." },
          ]}
          value={current}
          onSelect={(val) => run(q, () => onCorrect(q, val))}
        />
        {lab.corrected && ex.jev?.[q] && (
          <QuietLink disabled={busy !== null} onClick={() => run(q, () => onCorrect(q, null))} title="Remove your pick; the labeller's answer counts again, if there is one">
            back to Jev's
          </QuietLink>
        )}
        {lab.corrected && !ex.jev?.[q] && (
          <QuietLink disabled={busy !== null} onClick={() => run(q, () => onCorrect(q, null))} title="Remove your pick">
            clear
          </QuietLink>
        )}
        {lab.provisional && <span className="text-xs text-wait">nothing yet: no Jev answer</span>}
        {busy === q && <span className="text-xs text-slate">saving…</span>}
      </div>
    );
  };

  return (
    <div className="min-w-0">
      {showState && <StateBox state={ex.state} />}

      {narrow ? (
        <ul className={`${showState ? "mt-3" : ""} space-y-2`}>
          {ex.questions.map((q) => (
            <li key={q} className="rounded-lg border border-line bg-surface p-3">
              <QuestionName q={q} def={defs[q]} />
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                {cols.map((c) => (
                  <Row key={c.key} k={c.header}>
                    {c.cell(q)}
                  </Row>
                ))}
              </dl>
              <p className="mt-2 text-xs text-slate">Trains on</p>
              <div className="mt-1">{chips(q)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <div className={`scroll-x ${showState ? "mt-3" : ""} rounded-lg border border-line bg-surface`}>
          <table className="w-full border-collapse text-left" style={{ minWidth: 560 + cols.length * 120 }}>
            <caption className="sr-only">Every answer this request got, and the one it trains on</caption>
            <thead>
              <tr className="bg-panel text-xs text-slate">
                <th scope="col" className="w-[22%] border-b border-line px-3 py-1.5 font-medium">
                  Question
                </th>
                {cols.map((c) => (
                  <th key={c.key} scope="col" className="whitespace-nowrap border-b border-line px-3 py-1.5 align-top font-medium">
                    {c.header}
                  </th>
                ))}
                <th scope="col" className="border-b border-line px-3 py-1.5 align-top font-medium" title="The answer the next version learns for this question">
                  Trains on
                </th>
              </tr>
            </thead>
            <tbody>
              {ex.questions.map((q) => (
                <tr key={q} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-3 py-2 align-top font-normal">
                    <QuestionName q={q} def={defs[q]} />
                  </th>
                  {cols.map((c) => (
                    <td key={c.key} className="whitespace-nowrap px-3 py-2 align-top">
                      {c.cell(q)}
                    </td>
                  ))}
                  <td className="px-3 py-2 align-top">{chips(q)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {unreviewed && (
          <>
            <Badge tone="wait">unreviewed</Badge>
            <QuietLink tone="accent" disabled={busy !== null} onClick={() => run("__review", onLooksRight)}>
              Looks right: keep these answers
            </QuietLink>
          </>
        )}
        {ex.excluded && <Badge tone="stop">left out of training</Badge>}
        <QuietLink
          tone={ex.excluded ? "accent" : "danger"}
          disabled={busy !== null}
          onClick={() => run("__all", () => onCorrect("__all__", ex.excluded ? null : SKIP))}
        >
          {ex.excluded ? "Train on it again" : "Leave out of training"}
        </QuietLink>
        {busy === "__all" || busy === "__review" ? <span className="text-xs text-slate">saving…</span> : null}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 text-xs text-slate">
          {ex.holdout && <span title="Kept aside to measure each version; never trained on.">held out to measure</span>}
          <span>{sourceTag(ex)}</span>
          <span className="font-mono">{fmtT(ex.t)}</span>
        </span>
      </div>
    </div>
  );
}

function Row({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-slate">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function QuestionName({ q, def }: { q: string; def?: Questions[string] }) {
  return (
    <div className="min-w-0">
      <code className="font-mono text-sm text-ink">{q}</code>
      {def?.instructions && <p className="mt-0.5 text-xs text-slate">{def.instructions}</p>}
    </div>
  );
}

/** Every option of one answer with its probability, most likely first: a thin bar per option. */
export function Dist({ def, dist, top }: { def?: Questions[string]; dist: [string, number][]; top?: string }) {
  return (
    <ul className="mt-1.5 grid gap-0.5" aria-label="Every option with its probability">
      {dist.map(([o, p]) => (
        <li key={o} className="grid grid-cols-[minmax(56px,1fr)_minmax(24px,56px)_34px] items-center gap-2 font-mono text-xs">
          <span className={`truncate ${o === top ? "text-ink" : "text-slate"}`} title={displayAnswer(def, o)}>{displayAnswer(def, o)}</span>
          <span className="h-1.5 rounded-sm bg-panel" aria-hidden="true">
            <span className={`block h-1.5 rounded-sm ${o === top ? "bg-accent" : "bg-slate opacity-40"}`} style={{ width: `${Math.max(2, Math.round(p * 100))}%` }} />
          </span>
          <span className="text-right tabular-nums text-slate">{Math.round(p * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

/** One answer: the words, ✓/✗ against what the request trains on (when it has one), the confidence, and every option's
    probability. `all` shows every option; otherwise they open on click, and on their own when the top option is below 50%. */
export function Answer({
  def,
  a,
  label,
  all = false,
  differs = false,
}: {
  def?: Questions[string];
  a: Ans | null;
  label?: { raw: string | null; skip: boolean; provisional?: boolean };
  all?: boolean;
  /** red: differs from the column it's compared with */
  differs?: boolean;
}) {
  const unsure = !!a && a.p != null && a.p < 0.5;
  const [open, setOpen] = useState<boolean | null>(null);
  if (!a) return <span className="text-slate">—</span>;
  const mark = !label || label.skip || label.raw == null || label.provisional ? null : a.answer === label.raw;
  const many = (a.dist?.length || 0) > 1, shown = all || (open ?? unsure);
  return (
    <span className="block min-w-0 font-mono text-sm [overflow-wrap:break-word]">
      <span className={`whitespace-nowrap ${mark === false || differs ? "text-stop" : "text-ink"}`}>{displayAnswer(def, a.answer)}</span>
      {mark !== null && (
        <span className={`ml-1 ${mark ? "text-go" : "text-stop"}`} aria-label={mark ? "same as the answer it trains on" : "differs from the answer it trains on"}>
          {mark ? "✓" : "✗"}
        </span>
      )}
      {a.p != null && <span className={`ml-1.5 whitespace-nowrap text-xs ${unsure ? "text-wait" : "text-slate"}`}>{Math.round(a.p * 100)}%</span>}
      {many && !all && (
        <button type="button" className="ml-2 whitespace-nowrap text-xs text-slate underline decoration-dotted hover:text-ink" aria-expanded={shown} onClick={(e) => { e.stopPropagation(); setOpen(!shown); }}>
          {shown ? "hide options" : `all ${a.dist!.length}`}
        </button>
      )}
      {many && shown && <Dist def={def} dist={a.dist!} top={a.answer} />}
    </span>
  );
}

/** The state, folded to a few lines by default; long ones (agent transcripts, documents) open on request. */
export function StateBox({ state, maxHeight = 180 }: { state: unknown; maxHeight?: number }) {
  const text = typeof state === "string" ? state : JSON.stringify(state, null, 1);
  const long = text.length > 600 || text.split("\n").length > 6;
  const [open, setOpen] = useState(false);
  return (
    <div>
      <pre
        className="m-0 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-panel px-3 py-2 font-mono text-xs leading-relaxed text-ink"
        style={{ maxHeight: long && !open ? 96 : maxHeight, overflow: long && !open ? "hidden" : "auto" }}
      >
        {text}
      </pre>
      {long && (
        <button type="button" className="mt-1 text-xs text-accent hover:underline" onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}

/**
 * Height-animated reveal for an inline row. Mounts closed, opens on the next frame, and closes
 * before unmounting, so the rows below slide instead of jumping.
 */
export function Expand({ open, children, onClosed }: { open: boolean; children: ReactNode; onClosed?: () => void }) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      const r = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => onClosed?.(), reduce ? 0 : 200);
    return () => clearTimeout(t);
  }, [open, onClosed]);
  return (
    <div
      ref={ref}
      className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: shown ? "1fr" : "0fr" }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
