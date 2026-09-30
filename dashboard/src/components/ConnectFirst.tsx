/* The empty Requests page: connect a coding agent with a route token shown inline, or point your app at the proxy by hand. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "./Button";
import { CopyButton } from "./Bits";
import { Keys, Snippets, snippetQuestions, UrlRow } from "./Connect";
import { createRouteKey } from "../lib/api";
import { useProject } from "../lib/project";
import type { RoutesPage } from "../lib/types";

/** "For an agent": one button, one paste. Makes a route token and shows the prompt with it inline; always available on the route page. */
export function AgentPrompt({ routeId, url, reload }: { routeId: string; url: string; reload: () => Promise<unknown> }) {
  const [setup, setSetup] = useState<{ envLine: string; prompt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function make() {
    setBusy(true); setErr(null);
    try {
      const k = await createRouteKey(routeId);
      setSetup({ envLine: `DOPP_KEY=${k.key}`, prompt: agentPromptText(url, k.key, routeId) });
      await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-ink">For an agent <span className="font-normal text-slate">(Claude Code, Cursor, any coding agent): one paste, token inside.</span></div>
        {!setup && <Button onClick={make} disabled={busy}>{busy ? "Making a token…" : "Prompt for an agent"}</Button>}
      </div>
      {err && <p className="mt-1 text-sm text-stop">{err}</p>}
      {setup && (
        <div className="mt-2">
          <div className="relative"><pre className="whitespace-pre-wrap rounded-md border border-line bg-paper p-3 pr-20 text-sm text-ink">{setup.prompt}</pre><div className="absolute right-2 top-2"><CopyButton text={setup.prompt} /></div></div>
          <p className="mt-2 text-sm text-slate">The token is a key on this route; revoke it above any time. Prefer it out of the chat? <CopyButton text={setup.envLine} label="Copy the .env line" /> and tell the agent to read DOPP_KEY instead.</p>
        </div>
      )}
    </div>
  );
}
export const agentPromptText = (url: string, key: string, routeId: string) =>
  `Use Dopp for the decision-API (Jev-style) calls in this project. Endpoint: POST ${url}, header "Authorization: Bearer ${key}" (my Dopp route token; fine to keep in config, I can revoke it on ${location.host}). Request and response format, with examples: ${location.origin}/docs.md (send a "state" plus typed "questions"; the reply has one answer per question with probabilities). Every request is recorded at ${location.origin}/routes/${routeId}, where I train my own model on them later. If this codebase already calls TypeSafe's /v1/systemone, only the base URL and the bearer change. If it doesn't, look for decisions it makes about text with keyword lists, regexes or chains of ifs (routing, flagging, triage, yes-or-no checks), suggest the one or two where a typed question would do better, and ask me before changing anything.`;

export function ConnectFirst({ routes, routeId, reload }: { routes: RoutesPage | null; routeId: string | null; reload: () => Promise<unknown> }) {
  const route = routes?.routes.find((r) => r.id === routeId) || null;
  const { data: proj } = useProject(routeId || "");
  const [setup, setSetup] = useState<{ envLine: string; prompt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const url = routes?.url || location.origin + "/v1/systemone";
  const sq = snippetQuestions(proj);

  async function connectAgent() {
    if (!routeId) return;
    setBusy(true);
    setErr(null);
    try {
      const k = await createRouteKey(routeId); // a route token: fine to paste into a chat or a config; revoke it any time
      const envLine = `DOPP_KEY=${k.key}`;
      const prompt = agentPromptText(url, k.key, routeId);
      setSetup({ envLine, prompt });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-ink">No requests yet.</h2>
      <p className="mt-1 text-sm text-slate">Point your app at this server with a Dopp key. A coding agent can do it from one paste.</p>
      <div className="mt-4 mb-1 text-sm font-medium text-ink">Connect a coding agent (Claude Code, Cursor, any other):</div>
      {!routeId ? (
        <p className="text-sm text-slate">
          <Link to="/routes/new" className="text-accent hover:underline">Make a route</Link> first; its token is what your agent sends.
        </p>
      ) : setup ? (
        <div>
          <div className="text-sm font-medium text-ink">
            Paste this to your agent <span className="font-normal text-slate">(the token is inside; revoke it on the route's page any time)</span>
          </div>
          <div className="relative mt-1">
            <pre className="whitespace-pre-wrap rounded-md border border-line bg-paper p-3 pr-20 text-sm">{setup.prompt}</pre>
            <div className="absolute right-2 top-2"><CopyButton text={setup.prompt} /></div>
          </div>
          <p className="mt-2 text-sm text-slate">
            Prefer to keep it out of the chat? Put <span className="font-mono">{setup.envLine.slice(0, 14)}…</span> in .env yourself <CopyButton text={setup.envLine} label="copy the .env line" /> and tell the agent to read DOPP_KEY.
          </p>
        </div>
      ) : (
        <Button onClick={connectAgent} disabled={busy}>{busy ? "Making a token…" : "Connect an agent"}</Button>
      )}
      {err && <p className="mt-1 text-sm text-stop">{err}</p>}
      {routeId && (
        <>
          <p className="mt-3 text-sm text-slate">Or by hand{route ? ` (route ${route.name})` : ""}: same request and response as Jev. Swap the base URL and key in your app, or run this:</p>
          <div className="divide-y divide-line">
            <UrlRow label="Base URL" value={url} />
            <Keys routeId={routeId} keys={route?.keys ?? null} reload={reload} url={url} />
          </div>
          <div className="mt-3">
            <Snippets proxy={url} keyNote="a key from above" questions={sq.questions} own={sq.own} langs={["curl"]} />
            <p className="mt-2 text-sm text-slate">It shows up on this page within a few seconds, with who answered and how long it took.</p>
          </div>
        </>
      )}
    </section>
  );
}
