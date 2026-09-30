import type { Ans, ChunkSpan, Example, QuestionDef, Questions, QuestionSet, RawAnswer, Source, WireAnswer, Credits } from "./types";

/* ---------- vocabulary: one source for the tooltips ---------- */

export const DEF: Record<string, string> = {
  route: "One URL and its keys. Every request that comes in on a route's key is stored, and the route's setup decides who answers it.",
  upstream: "Anything that answers in Jev's shape: Jev, an LLM, a service that speaks Jev's API, or a model you trained.",
  model: "A model you trained on a route's requests, named after the route with its version: \"support-triage v2\".",
  state: "The text or JSON the questions are about. Any shape; same as TypeSafe.",
  questions:
    "An object of question id → question. Each is a choice (pick one option), noul (yes/no) or score (ordered levels).",
  example: "One request: a state, the questions asked about it, every answer given, and the answer it trains on.",
  label: "The answer a request trains on: yours if you picked one, otherwise the answer of whoever labels the route (you, unless you chose someone else).",
  "held-out":
    "One in ten requests you add (not your app's) is kept aside and never trained on, so agreement on it is honest.",
  Jev: "TypeSafe's hosted model. Its answers are labels only if you pick it to label a route.",
  agreement: "How often your model gives the same answer as the one a request trains on.",
  source:
    "Where a request came from: your app (through a key), the playground, pasted, a public dataset, or generated.",
  grounded:
    "The answer a request trains on: the labeller's (you by default), unless a person picked another answer or set their own.",
};

/* ---------- sources ---------- */

/** Where a request came from, as the tag the UI shows. The engine's source names stay on the wire. */
export const SOURCES: { key: Source; label: string; hint: string }[] = [
  { key: "traffic", label: "your app", hint: "Sent by your app through one of the route's keys" },
  { key: "typed", label: "playground", hint: "Sent from Try it, or typed in here" },
  { key: "pasted", label: "pasted", hint: "Pasted or uploaded" },
  { key: "public", label: "dataset", hint: "From a public dataset" },
  { key: "generated", label: "generated", hint: "Written by the generator, then answered by Jev" },
];
export const sourceLabel = (s: Source) => SOURCES.find((x) => x.key === s)?.label ?? s;

/** The tag on a request: "your app · us_ab12…", "playground", "dataset · org/name", "pasted", "generated". */
export function sourceTag(e: Pick<Example, "source" | "via">): string {
  const s = sourceOf(e);
  const v = e.via || "";
  if (s === "traffic" && v.startsWith("key ")) return `your app · ${v.slice(4)}…`;
  if (s === "public" && v.startsWith("hf:")) return `dataset · ${v.slice(3)}`;
  return sourceLabel(s);
}

/* ---------- answerers: always the model's name with the version ---------- */

/** "support-triage v2"; "your model" before a version exists or before the name has loaded. */
export function versionName(model: string | null | undefined, v: number | null | undefined): string {
  const n = modelName(model) || "your model";
  return v ? `${n} v${v}` : n;
}

/** Who a target is, in words: "Jev", "support-triage v2", an endpoint's name. `v` is the version that answered (from the row). */
export function targetName(
  target: string | null | undefined,
  o: { model?: string | null; v?: number | null; endpoints?: { target: string; name: string }[] | null },
): string {
  if (!target) return "nobody";
  if (target === "jev") return "Jev";
  if (target === "model") return versionName(o.model, o.v);
  if (target.startsWith("endpoint:")) return o.endpoints?.find((e) => e.target === target)?.name || "your endpoint";
  return target;
}

/** "412 ms", "3.1 s", "74 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

/** The version number out of a response's model field ("understudy/<tenant>-v3" → 3). */
export function versionOfWire(model?: string | null): number | null {
  const m = (model || "").match(/-v(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Old rows carry no source; derive it from `via`. */
export function sourceOf(e: Pick<Example, "source" | "via">): Source {
  if (e.source) return e.source;
  const v = e.via || "";
  if (v.startsWith("key")) return "traffic";
  if (v === "playground") return "typed";
  if (v.startsWith("hf:")) return "public";
  return "traffic";
}

/** Generated and public rows start unreviewed; any correction on them counts as a review. */
export const needsReview = (e: Example) => {
  const s = sourceOf(e);
  return (s === "generated" || s === "public") && !Object.keys(e.corrections || {}).length && !e.excluded;
};

/* ---------- prices ---------- */

export const JEV_PER_M_INPUT = 0.042;
export const TOKENS_PER_EXAMPLE = 200;

export function priceOf(n: number): string {
  const x = (n * TOKENS_PER_EXAMPLE * JEV_PER_M_INPUT) / 1e6;
  return x < 0.01 ? "<$0.01" : "~$" + x.toFixed(2);
}

/** The price of n more examples, from what this model's examples have actually cost (labelling them, plus writing them
    when the generator writes the request). Falls back to a rough guess until there is history. */
export function priceFor(n: number, credits: Credits | null, written: boolean): string {
  const pe = credits?.per_example;
  const label = pe?.label ?? pe?.label_guess ?? (TOKENS_PER_EXAMPLE * JEV_PER_M_INPUT) / 1e6;
  const write = written ? pe?.write ?? pe?.write_guess ?? null : 0;
  if (write == null) return priceOf(n) + " + writing";   // credits not loaded yet
  const x = n * (label + write);
  const guessed = pe?.label == null || (written && pe?.write == null);
  return (x > 0 && x < 0.01 ? "<$0.01" : "~$" + x.toFixed(2)) + (guessed ? " estimated" : "");
}

/** An estimate: "~$0.03", or "<$0.01" when it rounds to nothing. */
export const money = (x: number) => (x > 0 && x < 0.01 ? "<$0.01" : "~$" + x.toFixed(2));

/** How long n examples take: measured ~1.5 s per row when the generator writes the request around it, ~0.3 s when it's only labelled. */
export function timeFor(n: number, written: boolean): string {
  const s = n * (written ? 1.5 : 0.3);
  return s < 50 ? "under a minute" : "~" + Math.max(1, Math.round(s / 60)) + " min";
}
/** Time left from progress so far: "about 4 min left" once at least one chunk has finished. */
export function timeLeft(startedAt: number, done: number, total: number): string {
  if (!done) return "";
  const s = ((Date.now() - startedAt) / done) * (total - done);
  return s < 45 ? " · under a minute left" : ` · about ${Math.max(1, Math.round(s / 60))} min left`;
}

/* ---------- formatting ---------- */

export const pct = (x: number) => Math.round(x * 100) + "%";

export const pct1 = (x: number) => {
  const v = Math.floor(x * 1000) / 10;
  return (Number.isInteger(v) ? v : v.toFixed(1)) + "%";
};

export const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function ago(t?: number | null): string {
  if (!t) return "";
  const s = Date.now() / 1000 - (t > 1e12 ? t / 1000 : t);
  if (s < 5) return "just now";
  if (s < 90) return Math.round(s) + " s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

/** Seconds or milliseconds since the epoch → "Sep 22, 14:05". */
export const fmtT = (t?: number | null) =>
  t
    ? new Date(t > 1e12 ? t : t * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export const fmtDay = (t?: number | null) =>
  t ? new Date(t > 1e12 ? t : t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";

export const stateText = (s: unknown) => (typeof s === "string" ? s : JSON.stringify(s));

export const via = (v?: string | null) =>
  !v ? "" : v === "playground" ? "typed" : v.startsWith("hf:") ? v.slice(3) : v.startsWith("key ") ? v.slice(4) + "…" : v;

/* ---------- questions ---------- */

export const nice = (id: string) => id.replace(/[_-]+/g, " ");

/** The API names unnamed routes "Project N"; the UI calls them routes. */
export const modelName = (n?: string | null) => (n || "").replace(/^Project (\d+)$/, "Route $1");

/** Dollars: "$0.18", "$0.0042", "<$0.01" for tiny amounts when `rough`. */
/** Tiny amounts round UP to a tenth of a cent and say so: $0.00095 shows as "<$0.001", never as a bigger-looking "$0.001". */
export const usd = (x: number) => {
  if (x === 0) return "$0";
  if (x < 0.01) { const up = Math.ceil(x * 1000 - 1e-9) / 1000; return (up - x > 1e-9 ? "<$" : "$") + up.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""); }
  return "$" + x.toFixed(2);
};

/** Unix seconds for a yyyy-mm-dd day (start, or end when `end`). */
export const daySecs = (d: string, end = false) => (d ? Math.floor(new Date(d + (end ? "T23:59:59" : "T00:00:00")).getTime() / 1000) : null);
export const dayOf = (t?: number | string | null) => (t == null || t === "" ? "" : new Date(Number(t) * 1000).toISOString().slice(0, 10));

/* ---------- chunk sets: one question asked about every chunk (word) of a text ---------- */

export const CHUNK_Q = "{chunk}";

export const isChunkSet = (s?: QuestionSet | null) => !!s && s.shape?.kind === "chunks";

/** The one question definition of a chunk set (its template). */
export const chunkDef = (s: QuestionSet): QuestionDef | undefined => s.question_defs?.[CHUNK_Q];

/** "Chunk c{n}: {text}" → "Chunk" */
export function templateHead(t: string): string {
  const head = t.split("{")[0].replace(/[^A-Za-z ]+/g, " ").trim().split(/\s+/)[0];
  return head ? head[0].toUpperCase() + head.slice(1) : "Chunk";
}

/** A readable name: its given name, "Chunk → pii / none", or its question ids. */
/** Question-sets ordered by example count, most first (stable for ties). */
export const bySize = (sets: QuestionSet[]) => [...sets].sort((a, b) => (b.readiness?.calls ?? 0) - (a.readiness?.calls ?? 0));

export function setName(qs: QuestionSet): string {
  if (qs.name) return qs.name;
  if (qs.plan?.name) return qs.plan.name;
  if (isChunkSet(qs)) {
    const d = chunkDef(qs);
    const opts = optionsOf(d);
    const shown = opts.length > 4 ? opts.slice(0, 3).join(" / ") + ` +${opts.length - 3}` : opts.join(" / ");
    return `${templateHead(qs.shape && qs.shape.kind === "chunks" ? qs.shape.template : "Chunk")} → ${shown}`;
  }
  return qs.questions.join(", ");
}

/** Options that mean "nothing here" get no colour in a chunk text. */
export const isNegative = (o: string) => /^(none|no|false|nothing|neither|null|n\/a|o|outside|neutral|safe|clean)$/i.test(o);

/** A stable palette slot (1–6) for each non-negative option, in the set's option order. */
export function paletteOf(options: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  let i = 0;
  for (const o of options) if (!isNegative(o)) out[o] = (i++ % 6) + 1;
  return out;
}

/** The text a chunk example's chunks point into. */
export function chunkSource(state: unknown, s?: QuestionSet | null, chunks?: ChunkSpan[] | null): string | null {
  if (typeof state === "string") return state;
  if (!state || typeof state !== "object") return null;
  const o = state as Record<string, unknown>;
  // The field the plan (or an older recipe) names; failing that, the text field every chunk sits in.
  for (const f of [s?.plan?.seed_field, s?.recipe?.text_field]) if (f && typeof o[f] === "string") return o[f] as string;
  if (!chunks?.length) return null;
  const fits = (t: string) => chunks.every((c) => t.slice(c.start, c.end) === c.text);
  return Object.values(o).find((v): v is string => typeof v === "string" && fits(v)) ?? null;
}

/** Where each question's quoted piece sits in `text` (same rule as the server's chunkSpans): [{id, text, start, end}]. */
export function spansOf(text: string, questions: Questions): ChunkSpan[] {
  const out: ChunkSpan[] = [];
  let cursor = 0;
  for (const [id, q] of Object.entries(questions)) {
    const m = String(q.instructions || "").match(/"((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    let piece: string;
    try {
      piece = JSON.parse('"' + m[1] + '"');
    } catch {
      piece = m[1];
    }
    let at = text.indexOf(piece, cursor);
    if (at < 0) at = text.indexOf(piece);
    if (at < 0) continue;
    out.push({ id, text: piece, start: at, end: at + piece.length });
    cursor = at + piece.length;
  }
  return out;
}

/** One question per word of `text`, written from a per-word kind's template ("Chunk c{n}: {text}"), split on spaces.
    The app's own split may differ; the page says so. */
/** The quoted piece each question of a per-piece kind asks about, in question order. */
export const piecesOf = (qs: Questions | null | undefined): string[] =>
  Object.values(qs || {})
    .map((q) => {
      const m = String(q.instructions || "").match(/"((?:[^"\\]|\\.)*)"/);
      if (!m) return null;
      try {
        return JSON.parse('"' + m[1] + '"') as string;
      } catch {
        return m[1];
      }
    })
    .filter((x): x is string => x != null);

/** A state field that lists the pieces of the text one per line ("c0|Hey", "c1|yeah", …) is rebuilt for a new text by
    reading the line format off the old value: the same prefix (with its number counted up) and suffix around each new piece.
    Returns null when the old value doesn't list the old pieces line by line, so the caller can say so instead of guessing. */
export function relistPieces(oldValue: string, oldPieces: string[], newPieces: string[]): string | null {
  const lines = oldValue.split("\n");
  if (!oldPieces.length || lines.length !== oldPieces.length) return null;
  const at0 = lines[0].indexOf(oldPieces[0]);
  if (at0 < 0 || !lines.every((l, i) => l.includes(oldPieces[i]))) return null;
  const prefix = lines[0].slice(0, at0), suffix = lines[0].slice(at0 + oldPieces[0].length);
  if (!/\d+/.test(prefix) && lines.length > 1) return null;
  return newPieces.map((p, i) => prefix.replace(/\d+/, String(i)) + p + suffix).join("\n");
}

export function wordQuestions(s: QuestionSet, text: string): Questions {
  const sh = s.shape && s.shape.kind === "chunks" ? s.shape : null;
  const def = chunkDef(s);
  if (!sh || !def) return {};
  const out: Questions = {};
  text
    .split(/\s+/)
    .filter(Boolean)
    .forEach((w, i) => {
      const word = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || w;
      out[`${sh.prefix}${i}`] = { type: def.type, instructions: sh.template.replace("{n}", String(i)).replace("{text}", JSON.stringify(word)), criteria: def.criteria };
    });
  return out;
}

export function optionsOf(q?: QuestionDef): string[] {
  if (!q) return [];
  if (q.type === "noul") return ["yes", "no"];
  if (q.type === "score") return ((q.criteria as string[]) || []).map(String);
  return Array.isArray(q.criteria) ? q.criteria.map(String) : Object.keys(q.criteria || {});
}

/** The raw value the API stores for this option: level index for score, "true"/"false" for noul. */
export function labelValue(def: QuestionDef | undefined, option: string, index: number): string {
  if (!def) return option;
  if (def.type === "score") return String(index);
  if (def.type === "noul") return option === "yes" ? "true" : "false";
  return option;
}

/** Raw stored answer → the words the caller wrote. */
export function displayAnswer(def: QuestionDef | undefined, raw: string | number | null | undefined) {
  if (raw == null) return "—";
  const s = String(raw);
  if (!def) return s;
  if (def.type === "score") {
    const levels = (def.criteria as string[] | undefined) || [];
    const i = Number(s);
    return Number.isInteger(i) && levels[i] != null ? String(levels[i]) : s;
  }
  if (def.type === "noul") return s === "true" ? "yes" : s === "false" ? "no" : s;
  return s;
}

/** "wants=repair" → "wants = repair", with score/noul values shown in words. */
export function answerKeyLabel(defs: Questions | undefined, k: string): string {
  const i = k.indexOf("=");
  if (i < 0) return k;
  const qid = k.slice(0, i);
  return `${qid} = ${displayAnswer((defs || {})[qid], k.slice(i + 1))}`;
}

/** Every option of a /v1/systemone-shaped answer with its probability, most likely first. */
export function distOfWire(a: WireAnswer): [string, number][] {
  if (a.type === "noul") { const v = a.noul ?? 0; return ([["true", v], ["false", 1 - v]] as [string, number][]).sort((x, y) => y[1] - x[1]); }
  return Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]);
}

/** A /v1/systemone answer → the top option, its probability, and the whole distribution. */
export function wireToRaw(a: WireAnswer): Ans & { p: number } {
  const dist = distOfWire(a);
  if (a.type === "noul") {
    const v = a.noul ?? 0;
    return { answer: v >= 0.5 ? "true" : "false", p: Math.max(v, 1 - v), dist };
  }
  const probs = a.probabilities || {};
  if (a.type === "choice" && a.choice != null) return { answer: a.choice, p: probs[a.choice] ?? 0, dist };
  const best = dist[0]?.[0];
  if (best != null) return { answer: best, p: probs[best], dist };
  return { answer: String(a.choice ?? a.score ?? ""), p: 0, dist };
}

export function rawOf(a: RawAnswer | undefined | null): Ans | null {
  if (a == null) return null;
  if (typeof a === "string") return { answer: a };
  if (typeof a === "object" && "answer" in a) return { answer: String(a.answer), p: a.p, dist: a.dist };
  return null;
}

/* ---------- validation of a pasted questions object ---------- */

export const SAMPLE_QUESTIONS: Questions = {
  issue: {
    type: "choice",
    instructions: "What is the main issue?",
    criteria: { damaged: null, "wrong item": null, late: null, billing: null, question: null },
  },
  wants: {
    type: "choice",
    instructions: "What does the customer want?",
    criteria: { replacement: null, refund: null, repair: null, information: null },
  },
  angry: { type: "noul", instructions: "Is the customer angry?" },
};

/** Returns the parsed questions, or a sentence that says exactly what's wrong. */
export function parseQuestions(text: string): { ok: true; questions: Questions } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ok: false, error: "Questions must be an object of question id → question." };
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return { ok: false, error: "Add at least one question." };
  for (const [id, q] of entries) {
    if (!q || typeof q !== "object") return { ok: false, error: `"${id}" must be an object.` };
    const d = q as Partial<QuestionDef>;
    if (d.type !== "choice" && d.type !== "noul" && d.type !== "score")
      return { ok: false, error: `"${id}": type must be "choice", "noul" or "score".` };
    if (d.type === "choice") {
      const n = Array.isArray(d.criteria) ? d.criteria.length : Object.keys(d.criteria || {}).length;
      if (n < 2) return { ok: false, error: `"${id}": a choice needs at least two options in criteria.` };
    }
    if (d.type === "score" && (!Array.isArray(d.criteria) || d.criteria.length < 2))
      return { ok: false, error: `"${id}": a score needs criteria as a list of at least two levels, lowest first.` };
  }
  return { ok: true, questions: v as Questions };
}
