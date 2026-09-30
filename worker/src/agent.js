/* "Connect an agent": the operator makes a one-time link on a route's page (setup_links), pastes it to a coding agent, and the
   agent fetches it once to get a fresh key for that route as .env lines. The link lasts 15 minutes and works once. */
import { now, short, rand, sha256 } from "./lib.js";

/** .env lines for a key: what `curl … >> .env` appends. The comment lines carry what the agent should tell the person. */
export const envText = (origin, key, extra = []) => [...extra.map(l => "# " + l), "DOPP_BASE_URL=" + origin, "DOPP_KEY=" + key, ""].join("\n");

/** GET /setup/<token>: redeem a Connect-an-agent link once → a fresh key for that model, as .env lines. */
export async function setupRedeem(env, origin, token) {
  const l = await env.DB.prepare("SELECT * FROM setup_links WHERE token = ?").bind(token).first();
  const plain = (s, status = 404) => new Response("# " + s + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!l) return plain("This Dopp setup link isn't valid. Make a new one on the model's Requests page.");
  if (l.used_at) return plain("This Dopp setup link was already used. Make a new one on the model's Requests page.", 410);
  if (l.created_at + 15 * 60 * 1000 < now()) return plain("This Dopp setup link expired (they last 15 minutes). Make a new one on the model's Requests page.", 410);
  const taken = await env.DB.prepare("UPDATE setup_links SET used_at = ? WHERE token = ? AND used_at IS NULL").bind(now(), token).run();
  if (!taken.meta || !taken.meta.changes) return plain("This Dopp setup link was already used.", 410);
  const key = "us_" + rand(20), pr = await env.DB.prepare("SELECT id, name FROM projects WHERE id = ?").bind(l.project_id).first();
  await env.DB.prepare("INSERT INTO proxy_keys (id, key_hash, workspace_id, prefix, created_at, project_id) VALUES (?,?,?,?,?,?)").bind(short(), await sha256(key), l.workspace_id, key.slice(0, 8), now(), l.project_id).run();
  return new Response(envText(origin, key, [`Dopp key for "${(pr && pr.name) || "your model"}" (made ${new Date().toISOString().slice(0, 16)}Z). Requests: ${origin}/m/${l.project_id}/requests. Instructions: ${origin}/skill.md`]),
    { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
