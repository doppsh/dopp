/* Getting started: six steps from a first request to your own model answering, each ticked from the account's data
   (GET /api/onboarding, worker/src/onboarding.js). Shown after sign-in while any step is left; always in the sidebar. */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { cachedMe } from "../lib/api";
import { Page, PageHeader } from "../app/AppShell";
import { Button, LinkButton } from "../components/Button";
import { CopyButton } from "../components/Bits";
import { SAMPLE, Snippets } from "../components/Connect";
import { agentPromptText } from "../components/ConnectFirst";
import { cachedRoutes, createRoute, createRouteKey, estimateModel, fetchBases, fetchRequests, fetchRoutes, isMissing } from "../lib/api";
import { fmtMs, modelName, money, stateText, targetName } from "../lib/domain";
import { dismissStart, onboardingComplete, refreshOnboarding, useOnboarding } from "../lib/onboarding";
import type { OnboardingStep, StepId } from "../lib/onboarding";
import type { ModelEstimate, Req, RoutesPage } from "../lib/types";

const POLL_MS = 2500;
const WATCH_MS = 10 * 60 * 1000;

type Made = { routeId: string; url: string; key: string };

function DoppKey({ routes, reload, initial }: { routes: RoutesPage | null; reload: () => Promise<unknown>; initial: Made | null }) {
  const [made, setMade] = useState<Made | null>(initial);
  useEffect(() => {
    if (initial) setMade(initial);
  }, [initial]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const page = routes || (await fetchRoutes());
      const existing = page.routes[0];
      if (existing) {
        const k = await createRouteKey(existing.id);
        setMade({ routeId: existing.id, url: page.url, key: k.key });
      } else {
        const r = await createRoute({ name: "Default" });
        setMade({ routeId: r.route.id, url: r.url || page.url, key: r.key });
      }
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const prompt = made ? agentPromptText(made.url, made.key, made.routeId) : "";
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-ink">Use a Dopp key</h2>
      {!made ? (
        <>
          <p className="mt-3 text-sm text-slate">Point your app's base URL at this server and send a Dopp key as the bearer; the request and the reply stay the same. One click gives you a key and a prompt to paste into your coding agent. Jev answers until you train your own model.</p>
          <div className="mt-3">
            <Button variant="primary" onClick={go} disabled={busy}>{busy ? "Making your key…" : "Get a Dopp key"}</Button>
          </div>
          {err && <p className="mt-2 text-sm text-stop">{err}</p>}
        </>
      ) : (
        <>
          <p className="mt-3 text-sm font-medium text-ink">Paste this to your agent <span className="font-normal text-slate">(the key is inside; revoke it on the route's page any time)</span></p>
          <div className="relative mt-1">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper p-3 pr-20 text-sm text-ink">{prompt}</pre>
            <div className="absolute right-2 top-2"><CopyButton text={prompt} /></div>
          </div>
          <p className="mt-3 text-sm text-slate">Or send one yourself:</p>
          <div className="mt-1 min-w-0">
            <Snippets proxy={made.url} keyNote={made.key} questions={SAMPLE} own={false} real langs={["curl"]} />
          </div>
        </>
      )}
    </section>
  );
}

function FirstRequest({ r }: { r: Req }) {
  const who = targetName(r.served, { model: r.route_name });
  const ms = r.served && r.ms ? r.ms[r.served] : null;
  const s = stateText(r.state);
  return (
    <div className="mt-3 rounded-md border border-go bg-paper p-3">
      <p className="break-words font-mono text-sm text-ink">{s.length > 240 ? s.slice(0, 240) + "…" : s}</p>
      <p className="mt-2 text-sm text-slate">
        Answered by <span className="text-ink">{who}</span>
        {ms != null && (
          <>
            {" "}in <span className="font-mono text-ink">{fmtMs(ms)}</span>
          </>
        )}
        {" "}on route <span className="text-ink">{modelName(r.route_name)}</span>
      </p>
    </div>
  );
}

function Watch({ initial, count }: { initial: Req | null; count: number }) {
  const [first, setFirst] = useState<Req | null>(initial);
  const [watching, setWatching] = useState(true);
  const [resumed, setResumed] = useState(false);
  const started = useRef(Date.now());

  useEffect(() => {
    if (first || !watching) return;
    let alive = true;
    const tick = async () => {
      if (Date.now() - started.current > WATCH_MS) {
        setWatching(false);
        return;
      }
      if (document.visibilityState !== "visible") return;
      try {
        const p = await fetchRequests({}, 0, 1);
        if (alive && p.requests[0]) {
          setFirst(p.requests[0]);
          refreshOnboarding();
        }
      } catch {
        /* the next look tries again */
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [first, watching]);

  // stopped after ten minutes: coming back to the tab starts watching again
  useEffect(() => {
    if (first || watching) return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      started.current = Date.now();
      setResumed(true);
      setWatching(true);
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [first, watching]);

  return (
    <div className="rounded-md border border-line bg-paper p-3" aria-live="polite">
      {first ? (
        <>
          <h2 className="text-base font-semibold text-go">Your first request arrived.</h2>
          <FirstRequest r={first} />
          <p className="mt-3 text-sm text-slate">Every request lands on Requests, with who answered and how long it took.</p>
        </>
      ) : watching ? (
        <p className="flex items-center gap-2.5 text-base text-ink">
          <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-go opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-go" />
          </span>
          {count > 0 ? "Watching for your next request…" : resumed ? "Still watching for your first request…" : "Waiting for your first request…"}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-base text-slate">Nothing yet. Stopped checking after 10 minutes.</p>
          <Button
            onClick={() => {
              started.current = Date.now();
              setResumed(true);
              setWatching(true);
            }}
          >
            Keep watching
          </Button>
        </div>
      )}
    </div>
  );
}

const REFRESH_MS = 10_000;

/* The person's goal, per account in this browser (a per-viewer convenience). */
type Goal = "train" | "route" | "fresh";
const GOALS: { id: Goal; title: string; why: string }[] = [
  { id: "train", title: "Train my own model", why: "Learn from your requests and let your own model answer, with Jev as backup." },
  { id: "route", title: "Route and log my API calls", why: "One URL, a log of every request, and the freedom to switch who answers." },
  { id: "fresh", title: "I don't have traffic yet", why: "Get example requests first, then train on them." },
];
const goalKey = () => {
  const ws = cachedMe()?.workspace.id;
  return ws ? `dopp-goal:${ws}` : "dopp-goal";
};
function readGoal(): Goal | null {
  try {
    const g = localStorage.getItem(goalKey());
    return g === "train" || g === "route" || g === "fresh" ? g : null;
  } catch {
    return null;
  }
}
function saveGoal(g: Goal) {
  try {
    localStorage.setItem(goalKey(), g);
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
}

function GoalChooser({ goal, onPick }: { goal: Goal | null; onPick: (g: Goal) => void }) {
  return (
    <section aria-labelledby="goal-h" className="mt-4">
      <h2 id="goal-h" className="text-base font-semibold text-ink">What do you want to do?</h2>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {GOALS.map((g) => (
          <button
            key={g.id}
            type="button"
            aria-pressed={goal === g.id}
            onClick={() => onPick(g.id)}
            className={`rounded-lg border p-3 text-left transition-colors ${goal === g.id ? "border-go bg-go-soft" : "border-line bg-surface hover:bg-panel"}`}
          >
            <span className="block text-base font-semibold text-ink">{g.title}</span>
            <span className="mt-1 block text-sm text-slate">{g.why}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Three equal ways to get requests, each with what it costs and where it happens. */
function WaysToGetRequests({ connect }: { connect: ReactNode }) {
  const [app, setApp] = useState(false);
  const card = (title: string, cost: string, body: ReactNode) => (
    <div className="flex min-w-0 flex-col rounded-lg border border-line bg-paper p-3">
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-sm text-slate">{cost}</p>
      <div className="mt-3">{body}</div>
    </div>
  );
  const [routes, setRoutes] = useState<RoutesPage | null>(cachedRoutes());
  useEffect(() => {
    if (!routes) fetchRoutes().then(setRoutes).catch(() => null);
  }, [routes]);
  const first = routes?.routes[0]?.id ?? null;
  const go = (tab: "find" | "generate", label: string) =>
    first ? (
      <LinkButton to={`/routes/${encodeURIComponent(first)}#add-requests?tab=${tab}`}>{label}</LinkButton>
    ) : routes ? (
      <p className="text-sm text-slate">Make a route first; this opens on its page.</p>
    ) : (
      <span className="skel inline-block h-8 w-40" />
    );
  return (
    <>
      <div className="grid gap-2 lg:grid-cols-3">
        {card("Your app's own traffic", "Point your app at this server with a Dopp key; every request it sends is kept.",
          <Button onClick={() => setApp((v) => !v)} aria-expanded={app}>{app ? "Hide" : "Connect your app"}</Button>)}
        {card("Public datasets like your requests", "We search Hugging Face for sets that match your questions and you pick one. The route answers them; you, or the labeller you pick, label them.", go("find", "Find datasets"))}
        {card("Generate examples", "An LLM (GEN_API_KEY) writes requests like yours; you, or the labeller you pick, label them. Priced before you press.", go("generate", "Generate examples"))}
      </div>
      {app && <div className="mt-3">{connect}</div>}
    </>
  );
}

/** Training price for the route's labelled requests, from the server's estimate (never starts anything). */
function Price({ route }: { route: string }) {
  const [e, setE] = useState<{ est: ModelEstimate | null; err: string | null } | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const bases = await fetchBases();
        const base = (bases.find((b) => b.ready !== false) || bases[0])?.id;
        if (!base) return setE({ est: null, err: null });
        const est = await estimateModel({ route, base, epochs: 2, filter: { route: [route] } }, ctrl.signal);
        setE({ est, err: null });
      } catch (er) {
        if (!ctrl.signal.aborted) setE({ est: null, err: isMissing(er) ? null : (er as Error).message });
      }
    })();
    return () => ctrl.abort();
  }, [route]);
  if (!e) return <span className="skel inline-block h-4 w-48" />;
  if (e.err) return <p className="text-sm text-stop">{e.err}</p>;
  if (!e.est) return null;
  const x = e.est;
  if (!x.requests) return <p className="text-sm text-wait">No labelled requests on this route yet, so there is nothing to train on.</p>;
  return (
    <p className="text-sm text-slate">
      Right now: <span className="font-mono text-ink">{x.requests.toLocaleString()}</span> requests, about{" "}
      <span className="font-mono text-ink">{Math.max(1, Math.round(x.minutes))} min</span>, <span className="font-mono text-ink">{money(x.cost)}</span>.{" "}
      {x.estimate ? <span className="text-wait">Time and price are a guess ({x.estimate}).</span> : "From the time past trainings took."}
      {x.why_not ? <span className="text-wait"> {x.why_not}</span> : null}
    </p>
  );
}

const Check = ({ done, n }: { done: boolean; n: number }) =>
  done ? (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-go text-paper" aria-label="Done">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  ) : (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line font-mono text-xs text-slate" aria-label="Not done yet">{n}</span>
  );

function Step({ n, step, title, why, open, onToggle, children }: { n: number; step: OnboardingStep; title: ReactNode; why: ReactNode; open: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <li className={`rounded-lg border ${open && !step.done ? "border-go/60" : "border-line"} bg-surface`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <Check done={step.done} n={n} />
        <span className={`min-w-0 flex-1 text-base ${step.done ? "text-slate" : "font-semibold text-ink"}`}>{title}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`shrink-0 text-slate transition-transform ${open ? "rotate-180" : ""}`}><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="min-w-0 border-t border-line px-4 pb-4 pt-3 sm:pl-[52px]">
          <p className="max-w-[72ch] text-sm text-slate">{why}</p>
          {children && <div className="mt-3 min-w-0">{children}</div>}
        </div>
      )}
    </li>
  );
}

export default function Start() {
  const nav = useNavigate();
  const ob = useOnboarding();
  const [routes, setRoutes] = useState<RoutesPage | null>(cachedRoutes());
  const [first, setFirst] = useState<Req | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [goal, setGoal] = useState<Goal | null>(readGoal);
  const [choosing, setChoosing] = useState(false);
  const [later, setLater] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  const [makeErr, setMakeErr] = useState<string | null>(null);
  const making = useRef(false);
  const reload = () => fetchRoutes().then(setRoutes).catch(() => null);
  // No route yet: make "Default" and its key now, so the first thing a new account sees is a prompt it can paste.
  useEffect(() => {
    if (!routes || routes.routes.length || making.current) return;
    making.current = true;
    createRoute({ name: "Default" })
      .then((r) => {
        setMade({ routeId: r.route.id, url: r.url || routes.url, key: r.key });
        return reload();
      })
      .catch((e) => setMakeErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes]);
  useEffect(() => {
    dismissStart(); // shown once automatically per session; the sidebar brings it back
    reload();
    fetchRequests({}, 0, 1).then((p) => setFirst(p.requests[0] || null)).catch(() => null);
    refreshOnboarding();
    const t = setInterval(() => document.visibilityState === "visible" && refreshOnboarding(), REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = (rid?: string | null) => {
    const r = rid ? routes?.routes.find((x) => x.id === rid) : null;
    return r ? modelName(r.name) : null;
  };
  const steps = ob?.steps || [];
  const current = steps.find((s) => !s.done)?.id;
  const isOpen = (id: StepId) => opened[id] ?? id === current;
  const toggle = (id: StepId) => setOpened((o) => ({ ...o, [id]: !isOpen(id) }));
  const complete = onboardingComplete(ob);
  const watchN = ob?.watch_n || 10;

  const content = (s: OnboardingStep): { title: ReactNode; why: ReactNode; body?: ReactNode } => {
    const rn = nameOf(s.route_id);
    const setupTo = s.route_id ? `/routes/${encodeURIComponent(s.route_id)}#setup` : "/routes";
    switch (s.id) {
      case "connect": {
        const connect = (
          <div className="grid gap-4">
            <DoppKey routes={routes} reload={reload} initial={made} />
            {makeErr && <p className="text-sm text-stop">Couldn't make your first key: {makeErr}</p>}
          </div>
        );
        return {
          title: goal === "fresh" ? "Get some requests" : "Connect your app",
          why:
            goal === "fresh"
              ? "Requests are what a model learns from. There are three ways to get them; pick whichever fits."
              : "Point your app at Dopp so its requests are recorded. Every request is something your own model can learn from later.",
          body: s.done ? (
            <p className="text-sm text-slate">{(s.count || 0).toLocaleString()} requests recorded so far.</p>
          ) : goal === "fresh" ? (
            <WaysToGetRequests connect={connect} />
          ) : (
            connect
          ),
        };
      }
      case "watch":
        return {
          title: `Watch requests arrive`,
          why: `Send a few more; ${watchN} is enough to see what your traffic looks like and who answers it.`,
          body: (
            <>
              {!s.done && (s.count || 0) > 0 && (
                <p className="mb-2 text-sm text-slate">
                  <span className="font-mono text-ink">{s.count}</span> of {watchN} so far.
                </p>
              )}
              <Watch initial={first} count={s.count || 0} />
              <div className="mt-3"><LinkButton to="/requests" variant={s.done ? "secondary" : "primary"}>Open requests</LinkButton></div>
            </>
          ),
        };
      case "answers":
        return {
          title: "See who answered",
          why: "Open any request to see every answer it got, who gave it, how long it took, and which one counts as right for training.",
          body: <LinkButton to="/requests" variant={s.done ? "secondary" : "primary"}>Open a request</LinkButton>,
        };
      case "answerers":
        return {
          title: goal === "route" ? "Try another answerer on the same traffic" : "Pick answerers",
          why: goal === "route" ? "Add an answerer other than Jev and the route's own model (an open model like GLiNER, an LLM or your own service) to a route. It answers in the background next to Jev, so you can compare before you switch." : "Jev answers by default. Add an answerer other than Jev and this route's own model (an open model like GLiNER, an LLM, your own service, or another route's model) to a route, to reply, to answer in the background for comparison, or to label. Switching the route to its own model is the last step, not this one.",
          body: (
            <div className="flex flex-wrap gap-2">
              <LinkButton to="/upstreams" variant={s.done ? "secondary" : "primary"}>See answerers</LinkButton>
              <LinkButton to={setupTo}>{rn ? `Change the setup of ${rn}` : "Change a route's setup"}</LinkButton>
            </div>
          ),
        };
      case "train":
        return {
          title: "Train your first model",
          why: "Pick which requests to learn from and a base; you see the time and price before anything starts.",
          body: (
            <>
              {!s.done && s.route_id && <div className="mb-3"><Price route={s.route_id} /></div>}
              <LinkButton to={s.route_id ? `/models?train=1&route=${encodeURIComponent(s.route_id)}` : "/models"} variant={s.done ? "secondary" : "primary"}>
                {s.done ? "See your models" : "Choose requests and train"}
              </LinkButton>
            </>
          ),
        };
      case "switch":
        return {
          title: "Switch the route to your model",
          why: "Have your model answer first, with Jev as the fallback when it is unsure or you prefer. Or skip hosting: download the model or run it in the browser from Models.",
          body: (
            <div className="flex flex-wrap gap-2">
              <LinkButton to={setupTo} variant={s.done ? "secondary" : "primary"}>{rn ? `Change the setup of ${rn}` : "Change a route's setup"}</LinkButton>
              <LinkButton to="/models">Download or run in the browser</LinkButton>
            </div>
          ),
        };
    }
  };

  const row = (s: OnboardingStep, i: number) => {
    const c = content(s);
    return (
      <Step key={s.id} n={i + 1} step={s} title={c.title} why={c.why} open={isOpen(s.id)} onToggle={() => toggle(s.id)}>
        {c.body}
      </Step>
    );
  };

  return (
    <Page>
      <PageHeader
        title="Getting started"
        description={
          goal === "route"
            ? "One URL in front of your API: every request logged, and any answerer can take over."
            : "Requests in, a model out: get requests, pick who labels them, train, then let your model answer with Jev as backup."
        }
        action={
          !complete && (
            <Button variant="quiet" onClick={() => nav("/routes")}>
              Later
            </Button>
          )
        }
      />
      {!goal || choosing ? (
        <GoalChooser
          goal={goal}
          onPick={(g) => {
            saveGoal(g);
            setGoal(g);
            setChoosing(false);
          }}
        />
      ) : (
        <p className="mt-4 text-sm text-slate">
          Your goal: <span className="text-ink">{GOALS.find((g) => g.id === goal)?.title}</span>.{" "}
          <button type="button" className="text-accent hover:underline" onClick={() => setChoosing(true)}>
            Change goal
          </button>
        </p>
      )}
      {ob && (
        <p className="mt-4 text-sm text-slate">
          {complete ? "All done." : `${ob.done_count} of ${ob.total} done. Each step ticks itself when it happens.`}
        </p>
      )}
      {ob && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel" aria-hidden="true">
          <div className="h-full rounded-full bg-go transition-[width]" style={{ width: `${(100 * ob.done_count) / Math.max(1, ob.total)}%` }} />
        </div>
      )}
      {!ob ? (
        <div className="mt-4 space-y-2">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skel h-12 rounded-lg" />)}</div>
      ) : (
        <>
          <ol className="mt-4 space-y-2">
            {steps.slice(0, goal === "route" ? 4 : steps.length).map((s, i) => row(s, i))}
          </ol>
          {goal === "route" && (
            <div className="mt-4">
              <button type="button" className="text-sm text-accent hover:underline" aria-expanded={later} onClick={() => setLater((v) => !v)}>
                {later ? "Hide" : "When you're ready to train"}
              </button>
              {later && <ol className="mt-2 space-y-2">{steps.slice(4).map((s, i) => row(s, i + 4))}</ol>}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
