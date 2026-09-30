/* A route's URL, keys and code snippets: the route page and the New route done screen. */
import { useState } from "react";
import { Button } from "./Button";
import { CodeBlock, CopyButton } from "./Bits";
import { useToast } from "./Toast";
import { createRouteKey, forgetFreshKey, freshKey, rememberFreshKey, revokeRouteKey, sendTestRequest } from "../lib/api";
import { Answer } from "./Example";
import { upstreamName } from "../lib/upstreams";
import { ago, fmtDay, fmtMs, isChunkSet, wireToRaw } from "../lib/domain";
import type { ProjectDetail, Questions, RouteKey, WireAnswer } from "../lib/types";

export type Lang = "claude" | "curl" | "python" | "node";

export const SAMPLE: Questions = {
  wants: { type: "choice", instructions: "What does the customer want?", criteria: { replacement: null, refund: null, repair: null, information: null } },
};

/** The model's own questions for a snippet: the first fixed set's, else a sample. */
export function snippetQuestions(proj: ProjectDetail | null): { questions: Questions; own: boolean } {
  const set = proj?.question_sets?.find((s) => !isChunkSet(s) && s.question_defs && Object.keys(s.question_defs).length);
  return set ? { questions: set.question_defs!, own: true } : { questions: SAMPLE, own: false };
}

/** A JSON value as a Python literal (None/True/False). */
function py(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (Array.isArray(v)) return "[" + v.map(py).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${py(x)}`).join(", ") + "}";
  return JSON.stringify(v);
}

export function snippet(lang: Lang, proxy: string, keyNote: string, q: Questions, own = true, real = false): string {   // real: a sample request that IS recorded (the first-run page waits for it)
  // one question per line, so the snippet reads without horizontal scrolling
  const lines = (indent: string, lit: (v: unknown) => string = (v) => JSON.stringify(v)) =>
    "{\n" +
    Object.entries(q)
      .map(([k, v]) => `${indent}  ${JSON.stringify(k)}: ${lit(v)}`)
      .join(",\n") +
    `\n${indent}}`;
  if (lang === "claude") {
    // a prompt to paste into Claude Code (or any coding agent): it reads the skill file on this origin and makes the change itself
    const origin = proxy.replace(/\/v1\/systemone\/?$/, "");
    return `Route this app's Jev calls (TypeSafe's POST /v1/systemone) through Dopp.

1. Read ${origin}/skill.md and follow it.
2. Send those calls to ${proxy} instead of TypeSafe's URL. The request and response shapes stay exactly as they are.
3. Use the DOPP_KEY environment variable as the bearer token. I'll set it myself; it starts with us_. Never print, log or commit it.
4. Check it works: send one request with the header "x-dopp-test: 1" (this route answers it, nothing is saved) and show me the "understudy" block of the reply.

${own ? "This route's questions, for reference:" : "If this app doesn't call Jev yet, add a decide(state) helper that posts {state, questions} there, with these questions to start:"}
${lines("")}`;
  }
  // a real key becomes a shell line, so the block runs as pasted; otherwise say what to set
  const keyLine = keyNote.startsWith("us_") ? `DOPP_KEY=${keyNote}` : `# first: DOPP_KEY=<${keyNote}>`;
  if (lang === "curl")
    return own
      ? `${keyLine}
curl ${proxy} \\
  -H "Authorization: Bearer $DOPP_KEY" \\
  -H "content-type: application/json" \\
  -d '{"state": "<the text or JSON your app sends>",
       "questions": ${lines("       ")}}'`
      : `# ${real ? "A first request: answered by this route and recorded, so it shows up on this page." : "Test request: answered by this route, not saved (that's what x-dopp-test does)."}
${keyLine}
curl ${proxy} \\
  -H "Authorization: Bearer $DOPP_KEY" \\${real ? "" : "\n  -H \"x-dopp-test: 1\" \\"}
  -H "content-type: application/json" \\
  -d '{"state": "Trucks are loose, can you send new ones?",
       "questions": ${lines("       ")}}'
# Then point your app at ${proxy.replace(/\/v1\/systemone\/?$/, "")} with the key. Its first real request teaches this route your questions.`;
  if (lang === "python")
    return `# DOPP_KEY = ${keyNote}
import os, requests

QUESTIONS = ${lines("", py)}

def decide(state):
    r = requests.post(
        "${proxy}",
        headers={"Authorization": "Bearer " + os.environ["DOPP_KEY"]},
        json={"state": state, "questions": QUESTIONS},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["answers"]`;
  return `// DOPP_KEY = ${keyNote}
const QUESTIONS = ${lines("")};

export async function decide(state) {
  const r = await fetch("${proxy}", {
    method: "POST",
    headers: { Authorization: \`Bearer \${process.env.DOPP_KEY}\`, "content-type": "application/json" },
    body: JSON.stringify({ state, questions: QUESTIONS }),
  });
  if (!r.ok) throw new Error(\`Dopp \${r.status}: \${await r.text()}\`);
  return (await r.json()).answers;
}`;
}

export function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 py-2 sm:grid-cols-[110px_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
      <span className="text-sm text-slate">{label}</span>
      <code className="min-w-0 break-all font-mono text-base">{value}</code>
      <span className="justify-self-start">
        <CopyButton text={value} />
      </span>
    </div>
  );
}

/** A route's keys. A key made in this tab is shown in full once; after that only its prefix. Revoking asks inline. */
export function Keys({ routeId, keys, reload, url }: { routeId: string; keys: RouteKey[] | null; reload: () => Promise<unknown>; url?: string }) {
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(() => freshKey(routeId));
  const [sure, setSure] = useState<string | null>(null);
  const toast = useToast();
  const live = (keys || []).filter((k) => !k.revoked_at);
  const gone = (keys || []).filter((k) => k.revoked_at);

  async function make() {
    setBusy(true);
    try {
      const r = await createRouteKey(routeId);
      rememberFreshKey(routeId, r.key);
      setFresh(r.key);
      await reload();
    } catch (e) {
      toast.show((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(keyId: string) {
    try {
      await revokeRouteKey(routeId, keyId);
      setSure(null);
      await reload();
      toast.show("Key revoked. Requests using it now fail.");
    } catch (e) {
      toast.show((e as Error).message, "error");
    }
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 py-2 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-3">
      <span className="pt-1 text-sm text-slate">Keys</span>
      <div className="min-w-0">
        {fresh && <FreshKey value={fresh} onDone={() => { forgetFreshKey(routeId); setFresh(null); }} />}
        {fresh && url && (
          <div className="mt-2">
            <TestRequest url={url} keyValue={fresh} />
          </div>
        )}
        {!keys ? (
          <span className="skel mt-1 h-5 w-48" />
        ) : (
          <div className={`flex flex-col gap-1.5 ${fresh ? "mt-2" : ""}`}>
            {live.length ? (
              <ul className="min-w-0 space-y-1">
                {live.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <code className="font-mono text-base">{k.prefix}…</code>
                    <span className="text-sm text-slate">
                      {k.created_at ? `made ${fmtDay(k.created_at)} · ` : ""}
                      {k.last_used_at ? `last used ${ago(k.last_used_at)}` : "not used yet"}
                    </span>
                    {sure === k.id ? (
                      <span className="flex items-center gap-2 text-sm">
                        <span className="text-stop">Requests using it fail from now on.</span>
                        <Button size="sm" variant="danger" onClick={() => revoke(k.id)}>
                          Revoke {k.prefix}…
                        </Button>
                        <Button size="sm" variant="quiet" onClick={() => setSure(null)}>
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <button type="button" className="text-sm text-slate underline decoration-line underline-offset-2 hover:text-stop" onClick={() => setSure(k.id)}>
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              !fresh && <span className="text-sm text-slate">No live key. Make one to send requests.</span>
            )}
            {gone.length > 0 && (
              <p className="text-xs text-slate">
                Revoked: {gone.map((k) => <code key={k.id} className="mr-2 font-mono">{k.prefix}…</code>)}
              </p>
            )}
            <span>
              <Button size="sm" variant={live.length || fresh ? "secondary" : "primary"} loading={busy} onClick={make}>
                New key
              </Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** A full key, shown once. */
export function FreshKey({ value, onDone }: { value: string; onDone?: () => void }) {
  return (
    <div className="rounded border border-go/40 bg-go-soft p-3">
      <p className="mb-2 text-base font-medium text-ink">Your key. Copy it now; it isn't shown again.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border border-line bg-surface px-2 py-1.5 font-mono text-sm">{value}</code>
        <CopyButton text={value} />
        {onDone && (
          <Button size="sm" variant="quiet" onClick={onDone}>
            I've saved it
          </Button>
        )}
      </div>
    </div>
  );
}

export function Snippets({ proxy, keyNote, questions, own = true, real = false, langs = ["claude", "curl", "python", "node"] }: { proxy: string; keyNote: string; questions: Questions; own?: boolean; real?: boolean; langs?: Lang[] }) {
  const [lang, setLang] = useState<Lang>(langs[0]);
  return (
    <div className="min-w-0">
      {langs.length > 1 && (
        <div role="tablist" aria-label="Language" className="mb-2 inline-flex rounded border border-line p-0.5">
          {langs.map((l) => (
            <button
              key={l}
              role="tab"
              type="button"
              aria-selected={lang === l}
              onClick={() => setLang(l)}
              className={`rounded px-2.5 py-0.5 text-sm ${lang === l ? "bg-ink text-paper" : "text-slate hover:text-ink"}`}
            >
              {l === "claude" ? "Claude Code" : l === "curl" ? "curl" : l === "python" ? "Python" : "Node"}
            </button>
          ))}
        </div>
      )}
      <CodeBlock code={snippet(lang, proxy, keyNote, questions, own, real)} maxHeight={320} wrap={lang === "claude"} />
    </div>
  );
}

/** One sample request through the route's URL with a full key and `x-dopp-test: 1`: answered, not stored. */
export function TestRequest({ url, keyValue }: { url: string; keyValue: string }) {
  const [test, setTest] = useState<{ busy: boolean; res: Awaited<ReturnType<typeof sendTestRequest>> | null }>({ busy: false, res: null });
  const res = test.res;
  const us = (res?.body?.understudy || null) as { served?: string; fallback?: { from: string; reason: string } } | null;
  const answers = (res?.body?.answers || null) as Record<string, WireAnswer> | null;
  return (
    <div>
      <p className="mt-1 text-sm text-slate">
        Sends one sample request from this browser with the key and the <code className="font-mono">x-dopp-test: 1</code> header: it is answered but not stored.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          loading={test.busy}
          onClick={async () => {
            setTest({ busy: true, res: null });
            const r = await sendTestRequest(url, keyValue, { state: "Trucks are loose, can you send new ones?", questions: SAMPLE });
            setTest({ busy: false, res: r });
          }}
        >
          Send a test request
        </Button>
        {res && (
          <span className={`text-sm ${res.status >= 200 && res.status < 300 ? "text-go" : "text-stop"}`}>
            {res.status ? `HTTP ${res.status}` : "no answer"} in {fmtMs(res.ms)}
            {us?.served ? ` · answered by ${upstreamName(us.served, null)}` : ""}
            {us?.fallback ? ` · ${upstreamName(us.fallback.from, null)} gave ${us.fallback.reason}` : ""}
          </span>
        )}
      </div>
      {res && !answers && <pre className="mt-2 max-h-48 overflow-auto rounded border border-line bg-panel p-3 font-mono text-xs text-stop">{String(res.body?.error || JSON.stringify(res.body, null, 2))}</pre>}
      {answers && (
        <ul className="mt-2 space-y-1 rounded border border-line bg-surface p-3">
          {Object.entries(answers).map(([q, a]) => (
            <li key={q} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 text-sm">
              <code className="font-mono text-slate">{q}</code>
              <Answer def={SAMPLE[q]} a={wireToRaw(a)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
