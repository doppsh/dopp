/* Chunk examples: one question asked about every chunk (word) of a text, e.g. "is this word personal data?".
   Shown as the text itself with each chunk tinted by its label. No c0/c1 columns anywhere. */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Badge } from "./Badge";
import { QuietLink } from "./Button";
import { Chips } from "./Bits";
import { answerOf, compareOf, labelOf, misses, SKIP, targetsOf } from "./Example";
import type { Compare } from "./Example";
import { chunkDef, chunkSource, fmtT, labelValue, needsReview, optionsOf, paletteOf, sourceTag, stateText, targetName } from "../lib/domain";
import type { ChunkSpan, Example, QuestionDef, QuestionSet } from "../lib/types";

export function tint(slot: number | undefined): CSSProperties | undefined {
  if (!slot) return undefined;
  return { background: `var(--k${slot}-soft)`, boxShadow: `inset 0 -2px 0 var(--k${slot})` };
}

/** Label counts over an example's chunks, most common first: [["none", 26], ["pii", 6]]. */
export function chunkCounts(ex: Example): [string, number][] {
  const n: Record<string, number> = {};
  for (const q of ex.questions) {
    const l = labelOf(ex, q);
    const k = l.skip ? "unsure" : l.raw;
    if (k != null) n[k] = (n[k] || 0) + 1;
  }
  return Object.entries(n).sort((a, b) => b[1] - a[1]);
}

/** "pii 6 · none 26", coloured like the text. */
export function ChunkSummary({ ex, palette }: { ex: Example; palette: Record<string, number> }) {
  const c = chunkCounts(ex);
  if (!c.length) return <span className="text-slate">—</span>;
  const pos = c.filter(([k]) => palette[k]);
  const rest = c.filter(([k]) => !palette[k]);
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-xs">
      {[...pos, ...rest].map(([k, v]) => (
        <span key={k} className="whitespace-nowrap">
          <span className="rounded-sm px-0.5" style={tint(palette[k])}>
            {k}
          </span>{" "}
          <span className="tnum text-slate">{v}</span>
        </span>
      ))}
    </span>
  );
}

/** The text with its chunks marked. Interactive when onPick is given. */
export function ChunkText({
  text,
  chunks,
  ex,
  palette,
  onPick,
  selected,
  className = "",
}: {
  text: string;
  chunks: ChunkSpan[];
  ex: Example;
  palette: Record<string, number>;
  onPick?: (c: ChunkSpan) => void;
  selected?: string | null;
  className?: string;
}) {
  const sorted = [...chunks].sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let at = 0;
  for (const c of sorted) {
    if (c.start < at) continue;
    if (c.start > at) out.push(text.slice(at, c.start));
    const l = labelOf(ex, c.id);
    const slot = l.skip || l.raw == null ? undefined : palette[l.raw];
    const title = `${c.text}: ${l.skip ? "unsure" : l.raw ?? "no answer"}${l.corrected ? " (picked by you)" : l.provisional ? " (what your model answered; no label to train on yet)" : ""}`;
    const style: CSSProperties = {
      ...tint(slot),
      ...(l.corrected ? { outline: "1px dashed var(--ink)", outlineOffset: 1 } : {}),
      ...(l.skip ? { textDecoration: "line-through dotted" } : {}),
    };
    const seg = text.slice(c.start, c.end);
    out.push(
      onPick ? (
        <button
          key={c.id}
          type="button"
          title={title}
          aria-label={title}
          aria-pressed={selected === c.id}
          onClick={(e) => {
            e.stopPropagation();
            onPick(c);
          }}
          className={`rounded-sm px-px hover:bg-panel ${selected === c.id ? "ring-2 ring-accent" : ""}`}
          style={style}
        >
          {seg}
        </button>
      ) : (
        <span key={c.id} title={title} className="rounded-sm" style={style}>
          {seg}
        </span>
      ),
    );
    at = c.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <span className={`whitespace-pre-wrap break-words ${className}`}>{out}</span>;
}

/** The list row's text: the chunk text if it can be located, else the raw state. */
export function ChunkRowText({ ex, set, clamp }: { ex: Example; set?: QuestionSet; clamp: boolean }) {
  const text = chunkSource(ex.state, set, ex.chunks);
  const palette = paletteOf(optionsOf(set ? chunkDef(set) : undefined));
  if (!text || !ex.chunks?.length) return <span className={`text-sm ${clamp ? "clamp-2" : ""}`}>{stateText(ex.state)}</span>;
  return (
    <span className={`text-sm leading-relaxed ${clamp ? "clamp-2" : "block"}`}>
      <ChunkText text={text} chunks={ex.chunks} ex={ex} palette={palette} />
    </span>
  );
}

/** A request, opened, for a per-word kind: the text large; click a word to see every answer on it and pick the one it trains on. */
export function ChunkExample({
  ex,
  set,
  modelLabel,
  endpoints,
  compare,
  answered,
  onCorrect,
  onLooksRight,
}: {
  ex: Example;
  set?: QuestionSet;
  modelLabel?: string | null;
  endpoints?: { target: string; name: string }[] | null;
  /** the in-browser model picked in "Compare with": its answers per word, once scored */
  compare?: Compare;
  /** "Jev answered in 412 ms", shown under the text */
  answered?: ReactNode;
  onCorrect: (qid: string, label: string | null) => Promise<void>;
  onLooksRight: () => Promise<void>;
}) {
  const def: QuestionDef | undefined = set ? chunkDef(set) : undefined;
  const opts = optionsOf(def);
  const palette = paletteOf(opts);
  const text = chunkSource(ex.state, set, ex.chunks);
  const [sel, setSel] = useState<ChunkSpan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const unreviewed = needsReview(ex);
  const nameOf = (tg: string) => targetName(tg, { model: modelLabel, v: ex.v, endpoints });
  const targets = targetsOf(ex);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  if (!text || !ex.chunks?.length)
    return (
      <p className="text-sm text-slate">
        This request's words can't be found in its text, so they can't be set here. It still trains on its labels.
      </p>
    );

  const lab = sel ? labelOf(ex, sel.id) : null;
  const inBrowser = compare && compare.key !== "recorded" ? compare : null;
  // only when the compared answerer actually answered some of these words
  const compared = compare ? ex.chunks.filter((c) => compareOf(ex, c.id, compare)).length : 0;
  const cmpMiss = compare && compared ? ex.chunks.filter((c) => misses(ex, c.id, compare) > 0).length : null;
  const pickAnswer = (a: { answer: string } | null) => {
    if (!sel || !a || !lab || ex.excluded || (!lab.provisional && lab.raw === a.answer)) return null;
    const isJev = ex.jev?.[sel.id] && String(ex.jev[sel.id].answer) === a.answer;
    return (
      <QuietLink tone="accent" className="ml-1 text-xs" disabled={busy !== null} onClick={() => run(sel.id, () => onCorrect(sel.id, isJev && lab.corrected ? null : a.answer))}>
        use
      </QuietLink>
    );
  };

  return (
    <div className="min-w-0">
      <div className="rounded-lg border border-line bg-surface px-4 py-3 text-md leading-[1.9]">
        <ChunkText text={text} chunks={ex.chunks} ex={ex} palette={palette} onPick={(c) => setSel((s) => (s?.id === c.id ? null : c))} selected={sel?.id} />
      </div>

      <div className="mt-2 min-h-[64px] rounded-lg border border-line bg-surface px-3 py-2">
        {!sel ? (
          <p className="py-2 text-sm text-slate">
            Colours show the answer each word trains on. Click a word to see every answer on it, or change it.{" "}
            <span className="inline-flex flex-wrap gap-x-2 align-middle">
              {opts.map((o) => (
                <span key={o} className="rounded-sm px-1 font-mono text-xs" style={tint(palette[o])}>
                  {o}
                </span>
              ))}
            </span>
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <b className="font-mono font-medium text-ink">“{sel.text}”</b>
              {targets.map((tg) => {
                const a = answerOf(ex, tg, sel.id);
                return (
                  <span key={tg} className="text-slate">
                    {nameOf(tg)}:{" "}
                    <span className={`font-mono ${a && lab?.raw && !lab.provisional && a.answer !== lab.raw ? "text-stop" : "text-ink"}`}>{a ? a.answer : "—"}</span>
                    {a?.p != null && <span className="ml-1 font-mono text-xs">{Math.round(a.p * 100)}%</span>}
                    {pickAnswer(a)}
                  </span>
                );
              })}
              {inBrowser && (
                <span className="text-slate">
                  {inBrowser.name}:{" "}
                  {inBrowser.cell === "pending" ? (
                    "scoring…"
                  ) : inBrowser.cell === "unloaded" || !inBrowser.cell ? (
                    "not loaded"
                  ) : (
                    (() => {
                      const a = compareOf(ex, sel.id, inBrowser);
                      return (
                        <>
                          <span className={`font-mono ${a && lab?.raw && a.answer !== lab.raw ? "text-stop" : "text-ink"}`}>{a ? a.answer : "—"}</span>
                          {a?.p != null && <span className="ml-1 font-mono text-xs">{Math.round(a.p * 100)}%</span>}
                          {pickAnswer(a)}
                        </>
                      );
                    })()
                  )}
                </span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs text-slate">Trains on</span>
              <Chips
                ariaLabel={`Answer to train on for “${sel.text}”`}
                disabled={busy !== null || ex.excluded}
                options={[
                  ...opts.map((o, i) => ({ value: labelValue(def, o, i), label: o })),
                  { value: SKIP, label: "unsure", title: "Can't tell from the text. This word won't be trained on." },
                ]}
                value={lab?.skip ? SKIP : lab?.provisional ? null : lab?.raw ?? null}
                onSelect={(v) => run(sel.id, () => onCorrect(sel.id, v))}
              />
              {lab?.corrected && (
                <QuietLink disabled={busy !== null} onClick={() => run(sel.id, () => onCorrect(sel.id, null))} title="Remove your pick; the labeller's answer counts again, if there is one">
                  back to Jev's
                </QuietLink>
              )}
              {busy === sel.id && <span className="text-xs text-slate">saving…</span>}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <ChunkSummary ex={ex} palette={palette} />
        {compare && cmpMiss != null && (
          <span className={`font-mono text-xs ${cmpMiss ? "text-stop" : "text-go"}`}>
            {cmpMiss ? `${compare.name} differs on ${cmpMiss} of ${compared} words` : `${compare.name} agrees on all ${compared} words it answered`}
          </span>
        )}
        {answered}
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
        <span className="ml-auto flex flex-wrap items-center gap-x-3 text-xs text-slate">
          {ex.holdout && <span title="Kept aside to measure each version; never trained on.">held out to measure</span>}
          <span>{sourceTag(ex)}</span>
          <span className="font-mono">{fmtT(ex.t)}</span>
          <span>{ex.chunks.length} words</span>
        </span>
      </div>
    </div>
  );
}

/** Try it, per-word kinds: the text once per answerer, each word coloured by that answerer's answer. Words that differ
    from the reference answerer are outlined in red. */
export function WordsByAnswerer({
  text,
  spans,
  labels,
  reference,
  palette,
  name,
}: {
  text: string;
  spans: ChunkSpan[];
  labels: Record<string, string> | null;
  /** the answers to compare against (Jev's, or the first column's); null for the reference itself */
  reference: Record<string, string> | null;
  palette: Record<string, number>;
  name: string;
}) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let at = 0;
  let diff = 0;
  for (const c of sorted) {
    if (c.start < at) continue;
    if (c.start > at) out.push(text.slice(at, c.start));
    const l = labels?.[c.id];
    const ref = reference?.[c.id];
    const differs = !!(reference && l != null && ref != null && l !== ref);
    if (differs) diff++;
    out.push(
      <span
        key={c.id}
        className="rounded-sm"
        title={`${c.text}: ${l ?? "no answer"}${differs ? ` (the other says ${ref})` : ""}`}
        style={{ ...tint(l != null ? palette[l] : undefined), ...(differs ? { outline: "2px solid var(--stop)", outlineOffset: 1 } : {}) }}
      >
        {text.slice(c.start, c.end)}
      </span>,
    );
    at = c.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return (
    <div>
      <p className="mb-1 text-xs text-slate">
        {name}
        {reference && labels && <span className={diff ? "ml-2 text-stop" : "ml-2 text-go"}>{diff ? `differs on ${diff} of ${spans.length} words` : `same on all ${spans.length} words`}</span>}
      </p>
      <p className="whitespace-pre-wrap break-words rounded border border-line bg-surface px-3 py-2 text-base leading-[1.9]">{labels ? out : <span className="text-slate">{text}</span>}</p>
    </div>
  );
}
