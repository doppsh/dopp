/* The route page's Training section: the latest model, when each setup plan trains next (the server's own count, the same test
   it runs after every label), what training right now would take, and which answers are thin, one click from writing more. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LinkButton } from "./Button";
import { ProgressTrack } from "./ProgressTrack";
import { addRequestsHref } from "./AddRequests";
import { askUpstream, estimateAsk, estimateModel, fetchBases, getSetup, saveSetup } from "../lib/api";
import { ago, displayAnswer, isChunkSet, money, num, optionsOf, pct1, plural, setName, versionName } from "../lib/domain";
import { useProject } from "../lib/project";
import { upstreamName } from "../lib/upstreams";
import type { AutoPlan, Base, Gap, ModelEstimate, ModelVersion, QuestionSet, SetupState } from "../lib/types";
import { billingOn } from "../lib/server";

const POLL_MS = 10_000;

export function Training({ id, name }: { id: string; name: string | null }) {
  const [training, setTraining] = useState(false);
  const { data: proj, error, reload } = useProject(id, training ? POLL_MS : 0);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [est, setEst] = useState<{ e: ModelEstimate | null; err: string | null } | null>(null);
  const model = proj?.model || null;
  const plans = model?.auto || [];
  const labelled = model?.readiness?.calls ?? 0;

  const loadSetup = useCallback(() => {
    getSetup(id).then(setSetup).catch(() => setSetup(null));
  }, [id]);
  useEffect(() => {
    loadSetup();
    const again = () => {
      reload();
      loadSetup();
    };
    window.addEventListener("understudy:requests-added", again);
    window.addEventListener("understudy:setup-saved", again);
    return () => {
      window.removeEventListener("understudy:requests-added", again);
      window.removeEventListener("understudy:setup-saved", again);
    };
  }, [loadSetup, reload]);
  const trainingNow = model?.status === "training" || plans.some((p) => p.waiting === "training");
  useEffect(() => setTraining(trainingNow), [trainingNow]);

  // what "Train now" would take: the dry run of the exact training file, on the base the setup's first plan uses
  const first = setup?.setup.plans[0];
  const base = plans[0]?.base || first?.base || "laya";
  const epochs = plans[0]?.epochs || first?.epochs || 2;
  useEffect(() => {
    if (!labelled) return setEst(null);
    const ctrl = new AbortController();
    // the same pick the Train drawer starts with: all of this route's requests
    estimateModel({ route: id, base, epochs, filter: { route: [id] } }, ctrl.signal)
      .then((e) => setEst({ e, err: null }))
      .catch((e) => !ctrl.signal.aborted && setEst({ e: null, err: (e as Error).message }));
    return () => ctrl.abort();
  }, [id, base, epochs, labelled]);

  const who = useCallback(
    (ids: string[]) => {
      const names = [...new Set(ids)].map((a) => setup?.answerers.find((x) => x.id === a)?.name || upstreamName(a, null));
      return names.length ? names.join(", then ") : "nobody";
    },
    [setup],
  );
  // whose answers are the labels: the plan's own list, or each branch's "who is right"
  const labelsFrom = (p: AutoPlan | null) => {
    if (p?.oracle?.length) return who(p.oracle);
    const per = [...new Set((setup?.setup.routes || []).map((r) => who(r.oracle)))];
    return per.length ? per.join("; ") : "who is right in the setup";
  };

  const baseName = (b: string) => model?.bases?.[b] || b;
  const latest = model?.versions?.length ? model.versions[model.versions.length - 1] : null;
  const total = proj?.stats ? Object.values(proj.stats.by_source).reduce((a, b) => a + (b || 0), 0) : null;
  const held = proj?.stats?.holdout || 0;
  const noLabel = total != null ? Math.max(0, total - labelled - held) : 0;
  const trainHref = `/models?route=${encodeURIComponent(id)}&train=1`;

  return (
    <section id="training" aria-labelledby="training-h" className="mt-6 scroll-mt-20 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="training-h" className="text-base font-semibold text-ink">
          Training
        </h2>
        <span className="flex flex-wrap items-center gap-2">
          <Link to={`/models?route=${encodeURIComponent(id)}`} className="text-sm text-accent hover:underline">
            Models
          </Link>
          <LinkButton size="sm" variant="primary" to={trainHref}>
            Train a model now
          </LinkButton>
        </span>
      </div>

      {!proj ? (
        error ? (
          <p className="mt-2 text-sm text-stop">Couldn't load this route's training: {error}</p>
        ) : (
          <div className="mt-2 space-y-2">
            <span className="skel h-4 w-2/3" />
            <span className="skel h-3 w-full" />
          </div>
        )
      ) : (
        <div className="mt-2 space-y-3 text-sm">
          {/* the latest model, or none */}
          <p className="text-ink">
            {latest ? (
              <>
                The latest is <b className="font-medium">{versionName(name, latest.version)}</b> ({baseName(latest.base || "laya")}), trained {ago(latest.t)} on{" "}
                {plural(latest.trained_rows, "request")}
                {latest.holdout_agreement?.overall != null ? `; it gives the label on ${pct1(latest.holdout_agreement.overall)} of requests kept aside from its training` : ""}.
              </>
            ) : (
              <>No model trained on this route yet.</>
            )}
            {total === 0 ? (
              <span className="text-slate">
                {" "}
                No requests yet: send some from your app, or{" "}
                <a href="#add-requests?tab=paste" className="text-accent hover:underline">
                  add some
                </a>
                ; each one gets a label and counts toward training.
              </span>
            ) : total != null && (
              <span className="text-slate">
                {" "}
                {num(labelled)} of {plural(total, "request")} have a label{held ? `; ${num(held)} more are kept aside to check models` : ""}
                {noLabel ? `; ${num(noLabel)} have no label yet` : ""}.
              </span>
            )}
          </p>

          {model?.status === "training" && (
            <div className="rounded border border-line bg-panel px-3 py-2">
              <p className="text-ink">
                Training {versionName(name, (model.versions?.length ? Math.max(...model.versions.map((v) => v.version)) : 0) + 1)} now
                {model.train_started ? `, started ${ago(model.train_started)}` : ""}.{" "}
                <Link to={`/models?route=${encodeURIComponent(id)}`} className="text-accent hover:underline">
                  Progress on Models
                </Link>
              </p>
              {model.train_log?.length ? <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-slate">{model.train_log.slice(-2).join("\n")}</pre> : null}
            </div>
          )}

          {setup && <LabelsFrom id={id} setup={setup} onSaved={loadSetup} />}

          {/* the plans that train by themselves */}
          {setup && plans.length === 0 && (
            <p className="text-slate">
              Nothing on this route trains by itself: train when you like with the button above, or add a plan that trains every so many labelled requests to the{" "}
              <a href="#setup-h" className="text-accent hover:underline">
                setup
              </a>
              .
            </p>
          )}
          {plans.map((p) => (
            <PlanProgress key={p.plan} p={p} baseName={baseName(p.base)} labels={labelsFrom(p)} next={versionName(name, (latest?.version || 0) + 1)} latestName={latest ? versionName(name, latest.version) : null} agreement={model?.agreement_traffic ?? null} />
          ))}

          {/* what training right now would take */}
          {labelled > 0 && (
            <p className="text-slate">
              {!est ? (
                <span className="skel inline-block h-3 w-72 align-middle" />
              ) : est.err ? (
                <>Couldn't price a training right now: {est.err}</>
              ) : est.e && est.e.ready === false ? (
                <span className="text-wait">Training now on {baseName(base)} isn't possible: {est.e.why_not || "the trainer said no"}.</span>
              ) : est.e ? (
                <>
                  Training {baseName(base)} now would use {plural(est.e.requests, "labelled request")}: about{" "}
                  <b className="font-mono font-medium text-ink">{Math.max(1, Math.round(est.e.minutes))}</b> min and <b className="font-mono font-medium text-ink">{money(est.e.cost)}</b> {est.e.gpu === "CPU" ? "on this machine's CPU" : "on a GPU"}
                  {est.e.estimate ? ", a guess" : ", from the time past trainings took"}{est.e.gpu === "CPU" ? ". Nothing is billed." : billingOn() ? ". Each run is charged to your credit, including the ones a plan starts." : ". Each run is billed by the GPU provider, including the ones a plan starts."}
                </>
              ) : null}
            </p>
          )}

          <BasePicker id={id} name={name} versions={model?.versions || []} plan={plans[0]?.plan || first?.id || null} planName={plans[0]?.name || first?.name || null} planBase={plans[0]?.base || first?.base || null} plansAuto={plans.length > 0} scattered={isScattered(proj.question_sets || [], total ?? 0)} />

          <Kinds id={id} sets={proj.question_sets || []} gaps={model?.readiness?.gaps || []} labelled={labelled} total={total ?? 0} />
        </div>
      )}
    </section>
  );
}

function PlanProgress({
  p,
  baseName,
  labels,
  next,
  latestName,
  agreement,
}: {
  p: AutoPlan;
  baseName: string;
  labels: string;
  next: string;
  latestName: string | null;
  agreement: { n?: number; overall?: number | null } | null;
}) {
  const when = p.first
    ? `Trains ${next} on ${baseName} by itself once ${num(p.need)} requests have a label.`
    : `Trains ${next} on ${baseName} by itself after ${num(p.need)} more labelled requests${p.until_agreement ? `, while ${latestName || "the latest version"} still disagrees with the labels on live requests` : ""}.`;
  const status =
    p.waiting === "training"
      ? "A training on this base is running; the count carries on after it."
      : p.waiting === "agreement"
        ? agreement && (agreement.n ?? 0) >= 20 && agreement.overall != null
          ? `It has enough, but ${latestName} already agrees with the labels on ${pct1(agreement.overall)} of ${plural(agreement.n ?? 0, "live answer")}, so it waits.`
          : `It has enough, but it waits until ${latestName}'s background answers can be compared with the labels on 20 or more live requests.`
        : p.waiting === null
          ? "The next labelled request starts it."
          : null;
  return (
    <div className="rounded border border-line px-3 py-2">
      <p className="text-ink">
        <b className="font-medium">{p.name}</b> plan · {when}
      </p>
      <div className="mt-1.5">
        <ProgressTrack value={p.have} max={p.need} label={p.first ? "first training" : "next training"} unit="labelled requests" done={p.waiting === null} />
      </div>
      <p className="mt-1 text-slate">
        {status ? `${status} ` : ""}{/^You\b/.test(labels) ? "Labels: yours (fix or confirm answers on Requests)." : `Labels: ${labels}; your fixes always win.`}{" "}
        <a href={`#setup-plan=${encodeURIComponent(p.plan)}`} className="text-accent hover:underline">
          Change this plan
        </a>
      </p>
    </div>
  );
}

/* ---------- kinds of requests and their thin answers ---------- */

/** Which kind of request a thin answer belongs to, so "Write more" opens Generate on it. */

function Kinds({ id, sets, gaps, labelled, total }: { id: string; sets: QuestionSet[]; gaps: Gap[]; labelled: number; total: number }) {
  const live = liveKinds(sets);
  const scattered = isScattered(sets, total);
  const singles = live.filter((s) => s.readiness.calls === 1).length;
  const answers = useMemo(() => answerTotals(live), [live]);
  if (!live.length) return null;
  if (scattered)
    return (
      <div className="rounded border border-wait/40 bg-wait-soft px-3 py-2 text-ink">
        <p>
          Your {plural(total, "request")} landed in {num(live.length)} different kinds of requests{singles === live.length ? ", one request each" : singles * 2 > live.length ? ", most with one request each" : ""}. Their question ids change from request to request
          (for example one question per comment, keyed by the comment's id), and Dopp counts answers per question id. So it can't tell which answers are thin yet, and Generate
          can't write requests that match yours.
        </p>
        {answers.length > 0 && (
          <p className="mt-1 text-slate">
            Across all of them:{" "}
            {answers.map((g, i) => (
              <span key={g.key}>
                {i ? "; " : ""}
                {g.parts.map(([a, n]) => `${a} ${num(n)}`).join(" · ")}
              </span>
            ))}{" "}
            (answers, not requests).
          </p>
        )}
      </div>
    );
  return (
    <div>
      <p className="font-medium text-ink">Kinds of requests</p>
      <ul className="mt-1 space-y-0.5">
        {live.slice(0, 8).map((s) => (
          <li key={s.id} className="flex flex-wrap justify-between gap-x-3 text-slate">
            <span className="min-w-0 truncate text-ink">{setName(s)}</span>
            <span className="font-mono text-xs tnum">
              {num(s.readiness.labelled ?? s.readiness.calls)} labelled of {num(s.readiness.calls)}
            </span>
          </li>
        ))}
        {live.length > 8 && <li className="text-slate">and {plural(live.length - 8, "more kind")}</li>}
      </ul>
      {labelled > 0 && <Meter id={id} sets={live.filter((k) => k.readiness.calls >= 5)} need={gaps[0]?.need || 20} />}
    </div>
  );
}

/** Label counts added up across kinds, one group per kind of question (same type and options): "yes 41 · no 571". */
function answerTotals(sets: QuestionSet[]): { key: string; parts: [string, number][] }[] {
  const groups = new Map<string, Map<string, number>>();
  for (const s of sets)
    for (const [qid, counts] of Object.entries(s.readiness?.counts || {})) {
      const d = s.question_defs?.[qid];
      const key = d ? `${d.type}:${optionsOf(d).join("/")}` : "?";
      const g = groups.get(key) || new Map<string, number>();
      for (const [a, n] of Object.entries(counts)) {
        const shown = displayAnswer(d, a);
        g.set(shown, (g.get(shown) || 0) + n);
      }
      groups.set(key, g);
    }
  return [...groups]
    .map(([key, g]) => ({ key, parts: [...g].sort((a, b) => b[1] - a[1]) as [string, number][] }))
    .sort((a, b) => b.parts.reduce((s, x) => s + x[1], 0) - a.parts.reduce((s, x) => s + x[1], 0))
    .slice(0, 3);
}

const liveKinds = (sets: QuestionSet[]) => sets.filter((s) => !s.archived && (s.readiness?.calls ?? 0) > 0).sort((a, b) => (b.readiness?.calls ?? 0) - (a.readiness?.calls ?? 0));
/** More kinds than half the requests: the question ids change from request to request, so nothing adds up per question id. */
function isScattered(sets: QuestionSet[], total: number) {
  const n = liveKinds(sets).length;
  return n >= 5 && n * 2 > total;
}

/* ---------- which base: where it will run, whether it can read these requests, what it measured here ---------- */

type Where = "browser" | "server" | "download";
const WHERE: { id: Where; label: string; long: string }[] = [
  { id: "browser", label: "In a laptop browser", long: "in a browser tab, on the person's own machine (WebGPU), no server" },
  { id: "server", label: "Hosted", long: "hosted behind this route's URL" },
  { id: "download", label: "Downloaded, offline", long: "downloaded and run offline (Python or ONNX)" },
];
const whereKey = (id: string) => `dopp_where_${id}`;

interface Fit {
  b: Base;
  there: boolean;
  problem: string | null;
  best: ModelVersion | null;
}

function BasePicker({
  id,
  name,
  versions,
  plan,
  planName,
  planBase,
  plansAuto,
  scattered,
}: {
  id: string;
  name: string | null;
  versions: ModelVersion[];
  plan: string | null;
  planName: string | null;
  planBase: string | null;
  plansAuto: boolean;
  scattered: boolean;
}) {
  const [bases, setBases] = useState<Base[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [where, setWhereRaw] = useState<Where>(() => {
    try {
      const v = localStorage.getItem(whereKey(id));
      return v === "browser" || v === "download" || v === "server" ? v : "server";
    } catch {
      return "server";
    }
  });
  const setWhere = (w: Where) => {
    setWhereRaw(w);
    try {
      localStorage.setItem(whereKey(id), w);
    } catch {
      /* a remembered choice is a convenience only */
    }
  };
  useEffect(() => {
    fetchBases()
      .then(setBases)
      .catch((e) => setErr((e as Error).message));
  }, []);

  const fits: Fit[] = useMemo(() => {
    const out = (bases || []).map((b): Fit => {
      const there = (b.runs || (b.runs_in_browser ? ["server", "browser"] : ["server"])).includes(where);
      const problem =
        b.ready === false
          ? b.why_not || "can't be trained on this server right now"
          : scattered && (b.reads === "id" || b.reads === "fixed")
            ? "it learns one head per question id, and yours change with every request, so each one would be new to it"
            : null;
      // the best held-out result this route has measured for this base
      const mine = versions.filter((v) => (v.base || "laya") === b.id && v.holdout_agreement?.overall != null);
      const best = mine.sort((x, y) => (y.holdout_agreement!.overall ?? 0) - (x.holdout_agreement!.overall ?? 0))[0] || null;
      return { b, there, problem, best };
    });
    // runs there and reads these requests first; then measured best here; then the catalog's order (smallest first within a family)
    const rank = (f: Fit) => (f.there ? 0 : 2) + (f.problem ? 1 : 0);
    return out.sort((x, y) => rank(x) - rank(y) || (y.best?.holdout_agreement?.overall ?? -1) - (x.best?.holdout_agreement?.overall ?? -1));
  }, [bases, where, scattered, versions]);
  const pick = fits.find((f) => f.there && !f.problem) || null;
  const w = WHERE.find((x) => x.id === where)!;

  return (
    <div className="rounded border border-line px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-ink">Which base to train</p>
        <div role="radiogroup" aria-label="Where the model will run" className="flex flex-wrap gap-1">
          {WHERE.map((x) => (
            <button
              key={x.id}
              type="button"
              role="radio"
              aria-checked={where === x.id}
              onClick={() => setWhere(x.id)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${where === x.id ? "border-ink bg-ink text-paper" : "border-line text-slate hover:text-ink"}`}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {err ? (
        <p className="mt-1 text-stop">Couldn't load the bases: {err}</p>
      ) : !bases ? (
        <span className="skel mt-2 h-3 w-2/3" />
      ) : (
        <>
          <p className="mt-1 text-ink">
            {pick ? (
              <>
                For running {w.long}: <b className="font-medium">{pick.b.name}</b>
                {pick.best ? `, which gave the label on ${pct1(pick.best.holdout_agreement!.overall!)} of held-out requests as ${versionName(name, pick.best.version)}` : ""}.
                {planBase === pick.b.id && planName ? <span className="text-slate"> {plansAuto ? `The ${planName} plan already trains it.` : `It's the ${planName} plan's base.`}</span> : null}
              </>
            ) : (
              <>No base that trains here runs {w.long} and reads these requests. The list below says why for each.</>
            )}
          </p>
          {pick && (
            <p className="mt-1.5 flex flex-wrap gap-2">
              <LinkButton size="sm" to={`/models?route=${encodeURIComponent(id)}&train=1&base=${encodeURIComponent(pick.b.id)}`}>
                Train {pick.b.name} now
              </LinkButton>
              {plan && planBase !== pick.b.id && (
                <LinkButton size="sm" variant="quiet" to={`#setup-plan=${encodeURIComponent(plan)}&base=${encodeURIComponent(pick.b.id)}`}>
                  Make it the {planName ? `${planName} plan` : "plan"}'s base
                </LinkButton>
              )}
            </p>
          )}
          <ul className="mt-2 space-y-0.5 text-xs">
            {fits.map((f) => (
              <li key={f.b.id} className={`grid grid-cols-[minmax(120px,190px)_minmax(0,1fr)] gap-x-3 ${f.there && !f.problem ? "text-ink" : "text-slate"}`}>
                <span className="font-mono">{f.b.name}</span>
                <span>
                  {!f.there
                    ? `doesn't run ${w.long.split(",")[0]}; runs ${(f.b.runs || ["server"]).map((r) => (r === "server" ? "hosted" : r === "browser" ? "in a browser" : "downloaded")).join(", ")}`
                    : f.problem
                      ? f.b.ready === false ? `not available: ${f.problem}` : `can't read these well: ${f.problem}`
                      : "runs there and reads these requests"}
                  {f.best ? ` · measured here: ${pct1(f.best.holdout_agreement!.overall!)} held-out as ${versionName(name, f.best.version)}` : " · not tried on this route yet"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Who labels this route's requests for training, and whether its plans train by themselves: the two things a person changes first,
    saved into the route's setup (every branch's oracle; asked after the reply on every request that lacks its answer). Existing
    requests without that labeller's answer can be labelled in one go, priced first. */
function LabelsFrom({ id, setup, onSaved }: { id: string; setup: SetupState; onSaved: () => void }) {
  const s = setup.setup, cur = s.routes[0]?.oracle[0] || "you", you = cur === "you";
  const can = setup.answerers.filter((a) => a.ready && a.kind !== "version" && a.id !== "model" && a.id !== "you");
  const auto = s.plans.some((p) => p.auto);
  const [busy, setBusy] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  const [todo, setTodo] = useState<{ ids: string[]; usd: number | null } | null>(null);
  const nameOf = (u: string) => u === "you" ? "you" : setup.answerers.find((a) => a.id === u)?.name || upstreamName(u, null);
  const check = useCallback((u: string) => {
    // the requests with no label at all (added ones come labelled by the labeller; only these need asking)
    estimateAsk({ filter: { route: [id], labelled: "0" } }, u).then((e) => setTodo(e.to_ask ? { ids: e.ids || [], usd: e.est_usd } : null)).catch(() => setTodo(null));
  }, [id]);
  useEffect(() => { if (you) setTodo(null); else check(cur); }, [cur, you, check]);
  const save = async (next: typeof s, note: string) => {
    setBusy("save"); setErr(null);
    try { await saveSetup(id, next, note); window.dispatchEvent(new Event("understudy:setup-saved")); onSaved(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  // you: your fixes are the labels, nobody is asked; an upstream: it also answers, afterwards, the requests it didn't answer
  const pick = (u: string) => save({ ...s, routes: s.routes.map((r) => ({ ...r, oracle: [u], fill_pct: u === "you" ? 0 : 100 })) }, u === "you" ? "Labels from you" : `Labels from ${nameOf(u)}`);
  const toggleAuto = () => save({ ...s, plans: s.plans.map((p, i) => ({ ...p, auto: auto ? null : i === 0 ? { first_at: 100, every: 100, until_agreement: true } : p.auto })) }, auto ? "Plans train only when asked" : "Main plan trains by itself");
  const labelAll = async () => {
    if (!todo) return; setBusy("ask"); setErr(null);
    try { for (let i = 0; i < todo.ids.length; i += 25) { setBusy(`ask ${Math.min(i + 25, todo.ids.length)}/${todo.ids.length}`); await askUpstream(todo.ids.slice(i, i + 25), cur); }
      window.dispatchEvent(new Event("understudy:requests-added")); check(cur); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label htmlFor="labels-from" className="text-ink">Labels for training come from</label>
        <select id="labels-from" className="rounded border border-line bg-surface px-2 py-1 text-sm text-ink" value={cur} disabled={!!busy} onChange={(e) => pick(e.target.value)}>
          <option value="you">You (your fixes on Requests)</option>
          {!you && !can.some((a) => a.id === cur) && <option value={cur}>{nameOf(cur)}</option>}
          {can.map((a) => <option key={a.id} value={a.id}>{a.name}{a.per_1000_usd != null ? ` · ${money(a.per_1000_usd)}/1k` : ""}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-slate">
          <input id="plan-auto" type="checkbox" checked={auto} disabled={!!busy || !s.plans.length} onChange={toggleAuto} />
          train by itself every 100 labelled
        </label>
      </div>
      {you && (
        <p className="text-slate">
          Open a request on <a href="#requests" className="text-accent hover:underline">Requests</a> and fix or confirm its answer: that becomes its label.
          Or pick an LLM or another upstream here to label them for you.
        </p>
      )}
      {todo && (
        <p className="text-slate">
          {plural(todo.ids.length, "request")} here {todo.ids.length === 1 ? "has" : "have"} no label yet: {nameOf(cur)} hasn't answered {todo.ids.length === 1 ? "it" : "them"}.{" "}
          <button type="button" className="text-accent hover:underline disabled:opacity-60" disabled={!!busy} onClick={labelAll}>
            {busy?.startsWith("ask") ? `Labelling ${busy.slice(4)}…` : `Label them${todo.usd != null ? ` · ${money(todo.usd)}` : ""}`}
          </button>
        </p>
      )}
      {busy === "save" && <p className="text-slate">Saving…</p>}
      {err && <p className="text-stop">{err}</p>}
    </div>
  );
}

/** "Enough examples?": every answer of every question as a chip coloured by how many labelled examples it has (green: enough by our
    rule of thumb, amber: trainable but thin, red: too few to learn), answers that never came up folded away (a model can't learn
    them, and that's fine unless your users ask for them), and one line that says where the route stands. */
function Meter({ id, sets, need }: { id: string; sets: QuestionSet[]; need: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const FEW = 5;
  const rows = sets.flatMap((k) => Object.keys(k.question_defs || {}).map((qid) => {
    const def = k.question_defs![qid], counts = k.readiness.counts?.[qid] || {};
    const opts = optionsOf(def); const all = [...new Set([...opts, ...Object.keys(counts)])];
    const seen = all.filter((a) => (counts[a] || 0) > 0).sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
    return { k, qid, def, counts, seen, never: all.filter((a) => !(counts[a] > 0)) };
  }));
  if (!rows.length) return null;
  const tone = (n: number) => (n >= need ? "go" : n >= FEW ? "wait" : "stop");
  const chips = rows.flatMap((r) => r.seen.map((a) => tone(r.counts[a])));
  const go = chips.filter((t) => t === "go").length, wait = chips.filter((t) => t === "wait").length, stop = chips.filter((t) => t === "stop").length;
  const never = rows.reduce((n, r) => n + r.never.length, 0);
  const verdict = stop + wait === 0 ? { t: "go", s: "Enough to train: every answer your requests use has " + need + "+ examples." }
    : stop === 0 ? { t: "wait", s: "Trainable now; the amber answers will be shaky until they fill." }
    : { t: "stop", s: "Trainable, but the red answers have too few examples for a model to learn them." };
  const cls = { go: "bg-go-soft text-go", wait: "bg-wait-soft text-wait", stop: "bg-stop-soft text-stop" } as const;
  const worst = rows.flatMap((r) => r.seen.map((a) => ({ r, a, n: r.counts[a] }))).filter((x) => x.n < need).sort((x, y) => x.n - y.n)[0];
  return (
    <div className="mt-3">
      <p className="font-medium text-ink">Enough examples?</p>
      <p className={`mt-0.5 ${verdict.t === "go" ? "text-go" : verdict.t === "wait" ? "text-wait" : "text-stop"}`}>{verdict.s}</p>
      <p className="text-slate">
        <span className="text-go">{plural(go, "answer")} ready</span> · <span className="text-wait">{num(wait)} thin</span> · <span className="text-stop">{num(stop)} under {FEW}</span>
        {never ? ` · ${num(never)} never came up` : ""}. Green is {need}+ labelled examples, a rule of thumb until a trained version measures each answer.
      </p>
      <ul className="mt-2 divide-y divide-line">
        {rows.map((r) => {
          const key = r.k.id + "|" + r.qid, isOpen = open === key;
          return (
            <li key={key} className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1 py-2 md:grid-cols-[10rem_minmax(0,1fr)]">
              <code className="truncate font-mono text-xs text-slate" title={r.def?.instructions}>{isChunkSet(r.k) ? "each word" : r.qid}</code>
              <span className="flex flex-wrap items-center gap-1.5">
                {r.seen.map((a) => (
                  <span key={a} className={`rounded px-1.5 py-0.5 font-mono text-xs ${cls[tone(r.counts[a])]}`} title={`${num(r.counts[a])} labelled examples`}>
                    {displayAnswer(r.def, a)} <span className="tnum opacity-80">{num(r.counts[a])}</span>
                  </span>
                ))}
                {r.never.length > 0 && (
                  <button type="button" className="text-xs text-slate underline decoration-dotted hover:text-ink" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}>
                    {isOpen ? "hide" : `+${r.never.length} never came up`}
                  </button>
                )}
                {isOpen && r.never.map((a) => <span key={a} className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-slate">{displayAnswer(r.def, a)}</span>)}
              </span>
            </li>
          );
        })}
      </ul>
      {worst && (
        <p className="mt-2 flex flex-wrap gap-2">
          <LinkButton size="sm" to={`${addRequestsHref(id, "generate")}&kind=${encodeURIComponent(worst.r.k.id)}&aim=${encodeURIComponent(`${worst.r.qid}=${worst.a}`)}&count=20`}>
            Write 20 for {worst.r.qid} = {displayAnswer(worst.r.def, worst.a)}
          </LinkButton>
          <LinkButton size="sm" variant="quiet" to={`${addRequestsHref(id, "find")}&kind=${encodeURIComponent(worst.r.k.id)}`}>
            Find a dataset
          </LinkButton>
        </p>
      )}
    </div>
  );
}
