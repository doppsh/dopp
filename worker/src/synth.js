/* Making new examples in the customer's own request format — for any client, with no knowledge of any client.
   1. plan():     the generator (Gemini) reads real requests and says, in plain words, what it would write and how
                  (which parts of the state stay constant, which vary, whether/how the questions depend on the state).
                  The user sees that sentence and can correct it before anything is generated.
   2. compose():  the generator writes whole requests (state in the same shape, questions in the same format), optionally
                  around seed texts (dataset rows, pasted lines). Every request is checked against the format seen in traffic;
                  what doesn't match is dropped and counted. The route's labeller then labels the survivors like any other example. */
import { generator, hasGen, genModel, GEN_MISSING } from "./gen.js";
import { schemaIdFor, ingestRequests, examplesOfSet, upsertPlan } from "./data.js";
import { isChunks, CH, fill } from "./shape.js";
import { pool, nouls, EngineError } from "./lib.js";
import { checkDecide } from "./answer.js";

const clip = (v, n) => { const t = typeof v === "string" ? v : JSON.stringify(v); return t.length > n ? t.slice(0, n) + "…" : t; };
const stateKind = s => Array.isArray(s) ? "array" : s && typeof s === "object" ? "object" : "string";
const keysOf = s => (s && typeof s === "object" && !Array.isArray(s)) ? Object.keys(s).sort() : null;
const SLOT = /"((?:[^"\\]|\\.)*)"/;
// same kind = same option ids and type; an option's description is wording (it may carry live state)
const sig = q => JSON.stringify(q.criteria == null ? null : Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria).sort()) + "|" + (q.type || "");

/** Up to n real requests of a set, as the generator should see them (clipped, full questions). */
export async function samplesOf(env, set, n = 6) {
  const rows = await examplesOfSet(env, set, n);
  return rows.map(r => ({ state: r.state, questions: r.questions }));
}

/** What the generator would do for this set, in words the user can confirm or correct. Cached on the set; `correction` regenerates. */
export async function plan(env, ws, pr, set, correction = null) {
  if (!hasGen(env)) throw Object.assign(new Error(GEN_MISSING), { status: 503 });
  if (set.plan && !correction) return set.plan;
  const samples = await samplesOf(env, set, 6);
  if (!samples.length) throw Object.assign(new Error("No real requests yet. Send at least one request through your key first, so the plan can be read from your own traffic."), { status: 400 });
  const o = await generator(env,
    "You are looking at real requests to a decision API. Each request is {state, questions}. State is a string, an object, or an array; questions are typed (choice/noul/score) with instructions and options. Your job is to describe, precisely and briefly, how to write MORE requests of exactly this format, so a colleague could do it. Say what stays constant across requests and what varies; whether the questions are the same every time or depend on the state, and if they depend on it, the exact rule (e.g. one question per word of state.source_text, instructions 'Chunk c<i>: \"<word>\"'). Identify which single field (if any) holds the free text that a new request would be written around. Return {\"name\": \"a 2-5 word name for this kind of request, in the user's terms, e.g. 'PII yes/no per word', 'PII type per word', 'ticket triage'\", \"summary\": \"2-3 short plain sentences spoken TO the user about THEIR traffic, present tense, no jargon (say 'object', not 'JSON string'; never 'you must' or 'you will generate'). Pattern: 'Your state is an object. <constant fields> are the same in every request; <varying fields> change. <how the questions relate to the state, in one sentence>. I'll write new <varying field>s, build the matching <rest> and questions, and have this route's labeller label each one.'\", \"state_kind\": \"string|object|array\", \"constant\": [field names or 'none'], \"varying\": [field names], \"questions_depend_on_state\": true|false, \"questions_rule\": \"...\", \"seed_field\": \"field name that holds the main text, or null\", \"confidence\": 0..1, \"unsure\": \"what you are not sure about, or empty\"}",
    JSON.stringify({ real_requests: samples.map(s => ({ state: clip(s.state, 2500), questions: Object.fromEntries(Object.entries(s.questions).slice(0, 12).map(([k, q]) => [k, q])) , questions_total: Object.keys(s.questions).length })), ...(correction ? { user_correction: String(correction).slice(0, 800) } : {}) }),
    { max_tokens: 900, temperature: 0.2, pid: pr.id, note: "plan" });
  const p = { name: String(o.name || "").trim().slice(0, 60) || null, summary: String(o.summary || "").slice(0, 900), state_kind: o.state_kind || stateKind(samples[0].state), constant: Array.isArray(o.constant) ? o.constant.map(String) : [], varying: Array.isArray(o.varying) ? o.varying.map(String) : [],
    questions_depend_on_state: !!o.questions_depend_on_state, questions_rule: String(o.questions_rule || "").slice(0, 400), seed_field: o.seed_field ? String(o.seed_field) : null, confidence: Math.max(0, Math.min(1, +o.confidence || 0)), unsure: String(o.unsure || "").slice(0, 300),
    correction: correction ? String(correction).slice(0, 800) : null, model: genModel(env), t: Date.now() };
  await upsertPlan(env, set.id, p); set.plan = p; return p;
}

/** Does a generated request have the format the set's real requests have? Returns null if it does, else the reason. */
/** Generators sometimes hand back the state or questions as a JSON string; undo that before judging the format. */
function normalise(req, ex) {
  if (!req || typeof req !== "object") return req;
  const r = { ...req };
  for (const k of ["state", "questions"]) if (typeof r[k] === "string" && (k === "questions" || stateKind(ex.state) !== "string")) { try { const v = JSON.parse(r[k]); if (v && typeof v === "object") r[k] = v; } catch (_) {} }
  return r;
}
export async function formatProblem(tenant, set, samples, req) {
  if (!req || typeof req !== "object" || req.state === undefined || !req.questions || typeof req.questions !== "object") return "not a {state, questions} request";
  const ex = samples[0];
  if (stateKind(req.state) !== stateKind(ex.state)) return "state is a " + stateKind(req.state) + ", yours is a " + stateKind(ex.state);
  const kx = keysOf(ex.state), kr = keysOf(req.state);
  if (kx && JSON.stringify(kx) !== JSON.stringify(kr)) return "state fields differ (" + (kr || []).join(", ") + " vs " + kx.join(", ") + ")";
  if (typeof req.state === "string" && !req.state.trim()) return "empty state";
  if (!Object.keys(req.questions).length) return "no questions";
  if (isChunks(set)) {
    const id = await schemaIdFor(tenant, req.questions);
    if (id !== set.id) return "questions don't follow the same pattern as yours";
    const text = JSON.stringify(req.state);
    for (const [qid, q] of Object.entries(req.questions)) {
      const m = String(q.instructions || "").match(SLOT); if (!m) continue;
      let piece; try { piece = JSON.parse('"' + m[1] + '"'); } catch (_) { piece = m[1]; }   // the piece as written, quotes and all
      if (!text.includes(JSON.stringify(piece).slice(1, -1))) return "question " + qid + " asks about \"" + piece.slice(0, 30) + "\", which is not in the state";
    }
  } else {
    const want = set.q, got = req.questions;
    for (const k of Object.keys(want)) if (!got[k] || sig(got[k]) !== sig(want[k])) return "questions differ from yours (" + k + ")";
  }
  return null;
}

/** For a templated set: how to rebuild a whole request from just its varying parts. Read from one real request, no client knowledge. */
function templateFrom(set, ex) {
  const def = set.q[CH], template = set.shape.template, stringState = typeof ex.state === "string";
  const ids = Object.keys(ex.questions), start0 = Math.min(...ids.map(id => parseInt(id.replace(/^\D*/, ""), 10)).filter(n => !isNaN(n)).concat([Infinity])), start = isFinite(start0) ? start0 : 0, prefix = (set.shape.prefix || "");
  const piecesOf = qs => Object.values(qs).map(q => { const m = String(q.instructions || "").match(SLOT); if (!m) return null; try { return JSON.parse('"' + m[1] + '"'); } catch (_) { return m[1]; } }).filter(x => x !== null);
  // which fields are constant: same value in the real request as in the plan's list, or (no plan list) not the seed field
  const keys = stringState ? [] : Object.keys(ex.state), planConst = new Set((set.plan && set.plan.constant) || []);
  const constant = keys.filter(k => planConst.has(k)), varying = keys.filter(k => !planConst.has(k));
  const build = r => {
    if (!r || !Array.isArray(r.pieces) || !r.pieces.length) return null;
    let state;
    if (stringState) state = typeof r.state === "string" ? r.state : (r.state && typeof r.state === "object" && typeof Object.values(r.state)[0] === "string") ? Object.values(r.state)[0] : null;
    else { const v = typeof r.state === "string" ? (() => { try { return JSON.parse(r.state); } catch (_) { return null; } })() : r.state; if (!v || typeof v !== "object") return null; state = {}; for (const k of keys) state[k] = constant.includes(k) ? ex.state[k] : v[k]; }
    if (state === null || state === undefined) return null;
    const questions = {}; r.pieces.forEach((t, i) => { questions[prefix + (start + i)] = { type: def.type, instructions: fill(template, start + i, String(t)), ...(def.criteria != null ? { criteria: def.criteria } : {}) }; });
    return { state, questions };
  };
  return { template, constant, varying, stringState, piecesOf, build };
}

/** Write `count` new requests in the set's format (optionally one around each seed text), check them, label with the route's labeller, record.
    → {added, dropped: {format, realism}, reasons: [...first few], holdout, failed, plan, composed} */
export async function compose(env, ws, pr, set, { count = 20, seeds = null, target = null, hint = null, source = "generated", via = "generated", meta = null } = {}) {
  if (!hasGen(env)) throw Object.assign(new Error(GEN_MISSING), { status: 503 });
  const p = await plan(env, ws, pr, set);
  const samples = await samplesOf(env, set, 8);
  if (seeds) seeds = seeds.map(t => (typeof t === "string" ? t : JSON.stringify(t)).slice(0, 2500));   // a request per seed: long rows make replies that don't fit
  const n = seeds ? seeds.length : Math.max(1, Math.min(50, count));
  const fixedString = !isChunks(set) && stateKind(samples[0].state) === "string" && !p.questions_depend_on_state;
  let reqs = [], reasons = [];
  // Templated question sets ("one question per piece of the state"): the generator writes only what varies — the varying state
  // fields and the list of pieces — and the constant fields and the questions are filled from the pattern seen in traffic.
  // That is a few hundred output tokens per request instead of re-typing every question (5-10× cheaper), and the questions
  // can't drift from the customer's wording. Anything else is still written whole.
  const tpl = isChunks(set) ? templateFrom(set, samples[0]) : null;
  // the field a dataset row's text goes into: the plan's, when real requests have it; else the one string field that varies across them
  const objs = samples.filter(x => x.state && typeof x.state === "object" && !Array.isArray(x.state));
  const textField = (() => { if (isChunks(set) || !samples.length || objs.length !== samples.length) return null;
    if (p.seed_field && objs.every(x => typeof x.state[p.seed_field] === "string")) return p.seed_field;
    const cands = Object.keys(objs[0].state).filter(k => objs.every(x => typeof x.state[k] === "string"));
    const varying = cands.filter(k => new Set(objs.map(x => x.state[k])).size > 1 || objs.length === 1);
    return varying.length === 1 ? varying[0] : cands.length === 1 ? cands[0] : null; })();
  // writing new ones for such a request: the generator writes only that field's text (a command, a message), cheap and in the
  // user's words, and each goes into a real request like a dataset row does
  if (!seeds && !fixedString && textField) {
    const want = target ? `The correct answer to question "${target.qid}" (${(set.q[target.qid] || {}).instructions || ""}) must be "${target.answer}"${(set.q[target.qid] && set.q[target.qid].criteria && !Array.isArray(set.q[target.qid].criteria) && set.q[target.qid].criteria[target.answer]) ? ` (${set.q[target.qid].criteria[target.answer]})` : ""}.` : "Cover the range of answers the real ones get, including rare ones.";
    const o = await generator(env, `You write NEW values for one field of requests to a decision API: the field '${textField}', which holds what a real user wrote or said. Match the real values' style, length and language; vary wording, people and situations; write only realistic content a real user would produce. Return {"texts": ["...", ...]}.`,
      JSON.stringify({ real_values: objs.slice(0, 8).map(x => x.state[textField]), context_of_one_request: clip(Object.fromEntries(Object.entries(objs[0].state).filter(([k]) => k !== textField)), 1500), questions_asked_about_it: Object.fromEntries(Object.entries(set.q).map(([k, q]) => [k, { instructions: q.instructions, options: Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria || {}) }]).slice(0, 12)), instruction: `Write ${n} new values. ${want}${hint ? " Also: " + String(hint).slice(0, 500) : ""}` }),
      { max_tokens: 4000, temperature: 1, pid: pr.id, note: "write examples" });
    seeds = (Array.isArray(o.texts) ? o.texts : []).filter(t => typeof t === "string" && t.trim()).slice(0, n).map(t => t.trim());
  }
  // each row goes into a real request, which keeps its own questions: they fit its own context (options built from it)
  const direct = !fixedString && !!textField && !!seeds;
  if (seeds && fixedString) reqs = seeds.map(s => ({ state: s, questions: set.q }));   // nothing to compose: the text is the state, the questions are fixed
  // an object state whose text sits in one field, with fixed questions (a command plus context, e.g. a house's devices): each text goes into
  // that field of a real request, the rest of which stays as it was; nothing to write, so no generator call and no cost
  else if (direct)
    reqs = seeds.map((t, i) => { const x = samples[i % samples.length]; return { state: { ...x.state, [textField]: t }, questions: x.questions }; });
  else {
    const per = seeds ? (tpl ? 5 : 2) : 10, batches = [];
    for (let i = 0; i < n; i += per) batches.push(seeds ? seeds.slice(i, i + per) : Math.min(per, n - i));
    const task = b => Array.isArray(b) ? `Write one request around EACH of these ${b.length} texts, in order. Put each text in the field '${p.seed_field || "state"}' unchanged (trim only)`
                                        : `Write ${b} new, varied requests. ${target ? `Make sure the correct answer for ${target.qid === "chunk" ? "several of the questions" : target.qid} would be "${target.answer}".` : "Cover the range of answers seen in the real requests, including rare ones."}${hint ? " Also: " + String(hint).slice(0, 500) : ""}`;
    const write = async b => {
      if (tpl) {
        const o = await generator(env,
          `You write NEW requests for a decision API in the same format as the real one you are shown. The questions of these requests follow one pattern: one question per piece of the state, worded '${tpl.template}'. Do NOT write the questions and do NOT write the constant fields (${tpl.constant.join(", ") || "none"}); they are filled in from the real request. For each request return only the state fields that vary (${tpl.varying.join(", ") || "the state text"}) and "pieces": the exact pieces of the state the questions ask about, in order, split the same way the real request splits them (compare its pieces with its state). Every piece must appear literally in the state. Write realistic content a real system would receive — not descriptions of it. Return {"requests": [{"state": ${tpl.stringState ? "\"...\"" : "{varying fields only}"}, "pieces": ["...", ...]}, ...]}.`,
          JSON.stringify({ how_the_format_works: p, real_request: { state: clip(samples[0].state, 2500), pieces: tpl.piecesOf(samples[0].questions), questions_first_few: Object.fromEntries(Object.entries(samples[0].questions).slice(0, 4)), questions_total: Object.keys(samples[0].questions).length },
            instruction: task(b) + (Array.isArray(b) ? ", write the other varying fields as the real request does, and list the pieces." : ""), ...(Array.isArray(b) ? { texts: b } : {}) }),
          { max_tokens: 16000, temperature: Array.isArray(b) ? 0.3 : 1, pid: pr.id, note: "write examples" });
        return (Array.isArray(o.requests) ? o.requests : []).map(r => tpl.build(r)).filter(Boolean);
      }
      const o = await generator(env,
        "You write NEW requests for a decision API in exactly the same format as the real ones you are shown: same state shape and field names, same kind of questions, same instruction wording pattern, same option sets. Vary only what varies in the real ones. Write realistic content a real system would receive — not descriptions of it. Every question that refers to a piece of the state must refer to something that is literally present in the state. Return {\"requests\": [{\"state\": ..., \"questions\": {...}}, ...]}.",
        JSON.stringify({ how_the_format_works: p, real_requests: samples.slice(0, 4).map(s => ({ state: clip(s.state, 1800), questions: Object.fromEntries(Object.entries(s.questions).slice(0, 40)) })),
          instruction: task(b) + (Array.isArray(b) ? ", fill the rest of the state as the real requests do, and build the questions by the rule." : ""), ...(Array.isArray(b) ? { texts: b } : {}) }),
        { max_tokens: 16000, temperature: Array.isArray(b) ? 0.3 : 1, pid: pr.id, note: "write examples" });
      return Array.isArray(o.requests) ? o.requests : []; };
    const outs = await pool(batches, 3, async b => {
      try { return await write(b); }
      catch (e) {   // a cut-off reply: try each seed on its own before giving up on the batch
        if (!Array.isArray(b) || b.length < 2 || !/JSON/.test(e.message)) throw e;
        const one = []; for (const t of b) { try { one.push(...await write([t])); } catch (_) { reasons.push("the generator couldn't write a request around one row (reply cut off)"); } } return one;
      }
    });
    const bad = outs.find(r => r && r.__error); if (bad) throw bad.__error;
    reqs = outs.flat();
  }
  // 1. format check against the set's own traffic
  const keep = [];
  for (const r0 of reqs) { const r = normalise(r0, samples[0]); const why = await formatProblem(pr.tenant, set, samples, r); if (why) { if (reasons.length < 5) reasons.push(why); } else keep.push(r); }
  const droppedFormat = reqs.length - keep.length;
  // 2. realism gate: Jev compares candidates with real states (never recorded)
  let realistic = keep, droppedRealism = 0, gate = "checker";
  if (keep.length && samples.length) try {
    const anchors = samples.slice(0, 4).map(s => clip(s.state, 400)), chunks = [];
    for (let i = 0; i < keep.length; i += 8) chunks.push(keep.slice(i, i + 8));
    const res = await pool(chunks, 3, async ch => {
      const q = Object.fromEntries(ch.map((_, i) => ["c" + (i + 1), { type: "noul", instructions: `Does candidate c${i + 1} read like it came from the same place as the real examples (same kind of writer, format, length and topic), rather than obviously written by a generator?` }]));
      const a = await checkDecide(env, ws, pr, { real_examples: anchors, candidates: Object.fromEntries(ch.map((r, i) => ["c" + (i + 1), clip(r.state, 600)])) }, q, pr.id);
      return ch.map((_, i) => nouls(a["c" + (i + 1)]) >= 0.5);
    });
    const bad = res.find(r => r && r.__error); if (bad) throw bad.__error;
    const ok = res.flat(); realistic = keep.filter((_, i) => ok[i]); droppedRealism = keep.length - realistic.length;
  } catch (e) { if (!(e instanceof EngineError)) throw e; gate = "skipped: " + (JSON.parse(e.text || "{}").error || e.message); }   // Jev unavailable: keep everything, label later
  // nothing written is thrown away: every request that has the right format is recorded; the ones Jev thinks don't read like the
  // real ones are recorded too, left out of training by default and marked so, and the user can include them from the row
  const unreal = new Set(keep.map((_, i) => i).filter(i => !realistic.includes(keep[i])));
  const out = keep.length ? await ingestRequests(env, ws, pr, set, keep, source, via, { ...(meta || {}), generator: genModel(env), ...(target ? { target } : {}), ...(hint ? { hint } : {}) }) : { recorded: 0, holdout: 0, failed: [], ids: [], idByIndex: {}, skipped: 0 };
  let leftOut = 0;
  for (const i of unreal) { const id = out.idByIndex && out.idByIndex[i]; if (!id) continue; leftOut++;
    await env.DB.prepare(`INSERT INTO corrections (example_id, qid, label_json, "by", t) VALUES (?,?,?,?,?) ON CONFLICT(example_id, qid) DO UPDATE SET label_json = excluded.label_json, "by" = excluded."by", t = excluded.t`).bind(id, "__all__", JSON.stringify("__skip__"), "realism-check", Date.now() / 1000).run(); }
  return { added: out.recorded, left_out: leftOut, pending: out.pending || 0, gate, dropped: { format: droppedFormat, realism: 0, duplicate: out.skipped || 0 }, reasons, holdout: out.holdout, failed: out.failed, ids: out.ids, plan: p, composed: !(seeds && (fixedString || direct)), asked: reqs.length };
}
