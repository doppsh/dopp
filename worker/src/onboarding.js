/* Getting started (admin /start): GET /api/onboarding for the signed-in account. Six steps, each ticked from the account's own data:
   1 connect   ≥1 recorded request (request_log, or examples that came in as traffic)
   2 watch     ≥10 recorded requests
   3 answers   any request carries a second answer (answers_json has ≥2 answerers); the page also ticks it once the person
               has opened a request (a per-viewer flag in the browser, not stored here)
   4 answerers some route's setup names an answerer other than Jev and other than the route's own model (a base, an LLM,
               an endpoint, another route's model) as a step, in the background, or as who is right
   5 train     a ready trained version on any route (models.status = 'ready')
   6 switch    some route's setup asks one of the account's trained models first (routes[].steps[0])
   → { steps: [{ id, done, count?, link, route_id? }], done_count, total } */
import { json } from "./lib.js";
import { projectsOf } from "./projects.js";
import { latestSetup, resolveAnswerer } from "./setup.js";

const WATCH_N = 10;

export async function onboardingApi(env, ws) {
  const prs = await projectsOf(env, ws), ids = prs.map(p => p.id);
  let requests = 0, second = false, ready = [];
  if (ids.length) {
    const IN = `project_id IN (${ids.map(() => "?").join(",")})`, q = sql => env.DB.prepare(sql).bind(...ids);
    const [logN, exN, two, ms] = (await env.DB.batch([
      q(`SELECT COUNT(*) n FROM request_log WHERE ${IN}`),
      q(`SELECT COUNT(*) n FROM examples WHERE ${IN} AND source = 'traffic'`),
      q(`SELECT 1 x FROM examples WHERE ${IN} AND (SELECT COUNT(*) FROM json_each(examples.answers_json)) >= 2 LIMIT 1`),
      q(`SELECT project_id, version FROM models WHERE ${IN} AND status = 'ready' ORDER BY t DESC`)])).map(r => r.results);
    requests = Math.max(logN[0]?.n || 0, exN[0]?.n || 0); second = two.length > 0; ready = ms;
  }
  // setups: only saved ones are read (a route without one runs the default, which is Jev plus its own model)
  let picked = null, switched = null;
  for (const p of prs) {
    const s = (await latestSetup(env, p.id))?.setup; if (!s || !Array.isArray(s.routes)) continue;
    for (const r of s.routes) {
      const steps = r.steps || [], ids2 = [...steps.flatMap(st => st.split ? Object.keys(st.split) : [st.ask]), ...(r.background || []).map(b => b.ask), ...(r.oracle || [])].filter(Boolean);
      const other = ids2.find(id => { if (id === "jev") return false; const a = resolveAnswerer(s, id); return a && !(a.kind === "version" && (!a.project || a.project === p.id)); });
      if (other && !picked) picked = p.id;
      const first = steps[0], firstIds = first ? (first.split ? Object.keys(first.split) : [first.ask]) : [];
      if (!switched && ready.length && firstIds.some(id => resolveAnswerer(s, id)?.kind === "version")) switched = p.id;
    }
  }
  const main = prs[0]?.id || null, setupLink = rid => rid ? `/routes/${encodeURIComponent(rid)}#setup` : "/routes";
  const steps = [
    { id: "connect", done: requests >= 1, count: requests, link: "/start" },
    { id: "watch", done: requests >= WATCH_N, count: requests, link: "/requests" },
    { id: "answers", done: second, link: "/requests" },
    { id: "answerers", done: !!picked, link: "/upstreams", route_id: picked || main },
    { id: "train", done: ready.length > 0, count: ready.length, link: "/models", route_id: ready[0]?.project_id || main },
    { id: "switch", done: !!switched, link: setupLink(switched || ready[0]?.project_id || main), route_id: switched || ready[0]?.project_id || main },
  ];
  return json({ steps, done_count: steps.filter(s => s.done).length, total: steps.length, watch_n: WATCH_N });
}
