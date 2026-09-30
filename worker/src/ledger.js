/* Credits: every paid step a project causes is written down at our cost, and shown to the user as cost × margin.
   Metered: Jev tokens (labels, gates, traffic through the server's key), generator tokens, training GPU minutes.
   Metered: Jev tokens (labels, gates, traffic through the server's key), LLM tokens on the server's keys, generator tokens, training GPU minutes, and GPU
   time serving models (see chargeServing). Each charge says whether the customer pays it or it's on us (`billed`). */
const PRICES = env => ({
  jev_in: +(env.JEV_PRICE_IN || 0.042), jev_out: +(env.JEV_PRICE_OUT || 0.042),          // $ per 1M tokens
  gen_in: +(env.GEN_PRICE_IN || 0.10), gen_out: +(env.GEN_PRICE_OUT || 0.40),             // Gemini flash-lite list price
  gpu: { A10G: 1.10, H100: 3.95, T4: 0.59, L4: 0.80, CPU: 0 },                                              // $ per hour on Modal
  margin: +(env.PRICE_MARGIN || env.CREDITS_MARGIN || 1) });
export const marginOf = env => PRICES(env).margin;
/** What a customer pays per hour a model's container is awake (shared box or keep-awake alike): the T4 rate at the margin. */
export const servingUsdPerHour = env => Math.round(PRICES(env).gpu.T4 * PRICES(env).margin * 100) / 100;
const GUESS_TOKENS = 200;
const r6 = x => Math.round(x * 1e6) / 1e6;

// Done by the product on its own, never asked for: recorded at our cost, not billed.
export const ON_US = new Set(["naming", "plan", "suggest"]);
export function charge(env, pid, kind, units, usd, note = null, billed = null) {
  if (!pid || !(usd > 0)) return Promise.resolve();
  const b = billed === null ? !ON_US.has(note) : !!billed;
  return env.DB.prepare("INSERT INTO charges (project_id, t, kind, units, usd, note, billed) VALUES (?,?,?,?,?,?,?)").bind(pid, Date.now() / 1000, kind, units, r6(usd), note, b ? 1 : 0).run().catch(e => console.log("charge: " + e.message));
}
/** GPU time serving a model (a trained version or an open base model). A serving container stays up IDLE_S after its last request, so the
    time it runs is the union of [request, request + IDLE_S]: a request after a gap longer than that pays a fresh window (the wake-up),
    one inside the window pays only the extension since the last request. Tracked per container in the cache table. */
export async function chargeServing(env, pid, container, gpu = "T4", idle_s = 600, note = null) {
  const now = Date.now() / 1000, k = "served:" + container;
  const r = await env.DB.prepare("SELECT value_json FROM cache WHERE key = ?").bind(k).first(); const last = r ? JSON.parse(r.value_json).t : 0;
  await env.DB.prepare("INSERT OR REPLACE INTO cache (key, value_json, expires) VALUES (?,?,?)").bind(k, JSON.stringify({ t: now }), now + 86400).run();
  const secs = now - last > idle_s ? idle_s : now - last;   // woke up: a whole idle window; awake: the extension
  const p = PRICES(env);
  return charge(env, pid, "serving", secs / 60, (secs / 3600) * (p.gpu[gpu] || 0.59), note || (now - last > idle_s ? "wake " + container : container));
}
/** A Jev reply's usage → charge, unless the workspace pays Jev itself (own key). */
export function chargeJev(env, ws, pid, usage, note = null) {
  if (!usage || (ws && (ws.jev_pass || (ws.jev_mode === "own" && ws.ts_key_enc)))) return Promise.resolve();   // their key, their bill
  const p = PRICES(env), i = +usage.input_tokens || 0, o = +usage.output_tokens || 0;
  return charge(env, pid, "jev", i + o, (i * p.jev_in + o * p.jev_out) / 1e6, note);
}
export function chargeGen(env, pid, usage, note = null) {
  if (!usage) return Promise.resolve();
  const p = PRICES(env), i = +usage.prompt_tokens || 0, o = +usage.completion_tokens || 0;
  return charge(env, pid, "generator", i + o, (i * p.gen_in + o * p.gen_out) / 1e6, note);
}
export const chargeGpu = (env, pid, gpu, seconds, note = null) => charge(env, pid, "training", seconds / 60, (seconds / 3600) * (PRICES(env).gpu[gpu] ?? 1.10), note);

/** What the project has used so far, as the user sees it. */
export async function creditsOf(env, pid) {
  const p = PRICES(env);
  const rows = (await env.DB.prepare("SELECT kind, COUNT(*) n, SUM(units) units, SUM(usd) usd FROM charges WHERE project_id = ? AND billed = 1 GROUP BY kind").bind(pid).all()).results;
  const onUs = await env.DB.prepare("SELECT COUNT(*) n, COALESCE(SUM(usd), 0) usd FROM charges WHERE project_id = ? AND billed = 0").bind(pid).first();
  const lines = rows.map(r => ({ kind: r.kind, calls: r.n, units: Math.round(r.units), usd: r6(r.usd * p.margin) }));
  // what one more example costs here, from this project's own history: labeller tokens per labelled example, generator dollars per written example
  const lab = await env.DB.prepare("SELECT AVG(json_extract(extra_json, '$.usage.input_tokens')) i, AVG(json_extract(extra_json, '$.usage.output_tokens')) o FROM examples WHERE project_id = ? AND json_extract(extra_json, '$.usage.input_tokens') IS NOT NULL").bind(pid).first();
  const wr = await env.DB.prepare("SELECT (SELECT COALESCE(SUM(usd), 0) FROM charges WHERE project_id = ?1 AND note = 'write examples') usd, (SELECT COUNT(*) FROM examples WHERE project_id = ?1 AND source != 'traffic' AND (source = 'generated' OR json_extract(extra_json, '$.questions') IS NOT NULL) AND t >= (SELECT MIN(t) FROM charges WHERE project_id = ?1 AND note = 'write examples')) n").bind(pid).first();
  const per_example = { label: lab && lab.i != null ? r6(((+lab.i || 0) * p.jev_in + (+lab.o || 0) * p.jev_out) / 1e6 * p.margin) : null, write: wr && wr.n > 0 && wr.usd > 0 ? r6(wr.usd / wr.n * p.margin) : null,
    // until this project has history: the same prices at list, for a typical ~200-token request read and ~200 tokens written back (a guess, labelled so)
    label_guess: r6(GUESS_TOKENS * (p.jev_in + p.jev_out) / 1e6 * p.margin), write_guess: r6(GUESS_TOKENS * (p.gen_in + p.gen_out) / 1e6 * p.margin) };
  return { used: r6(lines.reduce((s, l) => s + l.usd, 0)), lines, margin: p.margin, per_example, on_us: { calls: onUs.n, usd: r6(onUs.usd * p.margin), what: "naming your kinds of requests and suggesting datasets" }, unmetered: [] };
}
