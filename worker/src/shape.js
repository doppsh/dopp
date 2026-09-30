/* Question-set shapes. A request's questions can be a FIXED list ("wants", "issue"…) or TEMPLATED: many questions that
   are the same question asked about different pieces of the state (pii-tagger: `Chunk c12: "Alex"` → pii | none, one per
   word). Identity, counting, training and ingest all key off the shape, never off literal ids.

   shape = { kind: "fixed" } | { kind: "chunks", type, criteria, template, prefix }
     template: the instructions with the varying parts as slots: `Chunk {id}: {text}`
   */

export const CH = "{chunk}";                       // the one question id a chunk set exposes for definitions and counts

const SLOT_STR = /"(?:[^"\\]|\\.)*"/g;             // a JSON-quoted string inside the instructions
const SLOT_ID = /\b([A-Za-z]{0,3})(\d+)\b/g;        // c12, t7, 12
export function templateOf(instructions) {
  return String(instructions).replace(SLOT_STR, "{text}").replace(SLOT_ID, (_, p) => (p || "") + "{n}");
}
const sig = q => JSON.stringify(q.criteria ?? null) + "|" + (q.type || "");

/** The shape of one request's questions. Chunk shape needs ≥2 questions with the same type/options and a template with a slot. */
export function shapeOf(questions) {
  const ids = Object.keys(questions || {}); if (ids.length < 2) return { kind: "fixed" };
  const first = questions[ids[0]], s0 = sig(first), t0 = templateOf(first.instructions);
  if (!/\{(text|n)\}/.test(t0)) return { kind: "fixed" };
  for (const id of ids) { const q = questions[id]; if (sig(q) !== s0 || templateOf(q.instructions) !== t0) return { kind: "fixed" }; }
  const m = ids[0].match(/^([A-Za-z_]*)\d+$/);
  return { kind: "chunks", type: first.type, criteria: first.criteria ?? null, template: t0, prefix: m ? m[1] : "" };
}
export const isChunks = set => !!set && (set.shape || {}).kind === "chunks";
/** The question definitions a chunk set stores: one template question under {chunk}. */
export const templateQuestions = sh => ({ [CH]: { type: sh.type, instructions: sh.template, criteria: sh.criteria } });
/** The definition used to read any answer of a set: chunk sets have one, fixed sets one per id. */
export const defOf = (set, qid) => isChunks(set) ? set.q[CH] : set.q[qid];
/** Question ids an example actually has: a chunk example carries its own; fixed examples use the set's. */
export const qidsOf = (set, row) => isChunks(set) ? Object.keys((row && row.questions) || (row && row.jev) || {}) : Object.keys(set.q);
export const fill = (template, n, text) => template.replace("{n}", String(n)).replace("{text}", JSON.stringify(text));

/** Where each question's quoted piece sits in the state's main text, for highlighting: [{id, text, start, end}] or null.
    No client knowledge: we search the largest string field of the state (or the string state) for each quoted value, in order. */
export function chunkSpans(state, questions, preferField = null) {
  const ids = Object.keys(questions || {}), pieces = [];
  for (const id of ids) { const m = String(questions[id].instructions || "").match(/"((?:[^"\\]|\\.)*)"/); if (!m) continue; let piece; try { piece = JSON.parse('"' + m[1] + '"'); } catch (_) { piece = m[1]; } pieces.push([id, piece]); }
  if (!pieces.length) return null;
  let text = null;
  if (typeof state === "string") text = state;
  else if (state && typeof state === "object" && !Array.isArray(state)) {
    // the field the pieces come from: the plan's text field if it fits, else the string field that contains the most pieces,
    // preferring prose over an "id|piece" listing when both contain them all
    const cands = Object.entries(state).filter(([, v]) => typeof v === "string");
    const score = ([k, v]) => pieces.filter(([, p]) => v.includes(p)).length * 10 + (k === preferField ? 5 : 0) - (/^[A-Za-z_]*\d+\|/m.test(v) ? 3 : 0);
    if (!cands.length) return null; text = cands.sort((a, b) => score(b) - score(a))[0][1];
  }
  if (text === null) return null;
  const out = []; let cursor = 0;
  for (const [id, piece] of pieces) { let at = text.indexOf(piece, cursor); if (at < 0) at = text.indexOf(piece); if (at < 0) continue; out.push({ id, text: piece, start: at, end: at + piece.length }); cursor = at + piece.length; }
  return out.length ? out : null;
}
