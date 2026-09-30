/* Analytics: how the proxy is doing for this account (or one route) over 7 or 30 days. Definitions live
   next to every number here. Three latencies are never mixed: end to end (as your app sees it), upstream call, and Dopp overhead. */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Page, PageHeader } from "../app/AppShell";
import { fetchAnalytics } from "../lib/api";
import { fmtMs, modelName, num, pct1, plural } from "../lib/domain";
import type { Analytics as A, Dist } from "../lib/types";
import { billingOn } from "../lib/server";

const COLORS = ["var(--go)", "var(--accent)", "var(--wait)", "var(--slate)", "var(--stop)"];
const KIND: Record<string, string> = { jev: "Jev answers", llm: "LLM answers", serving: "Models answering (GPU time)", training: "Training (GPU)", generator: "Writing requests and labels" };
const REASON: Record<string, string> = { unsure: "first answer was less sure than the route allows", slow: "no answer in the time the route allows", error: "the answerer returned an error", skipped: "couldn't answer at all (no version yet, paused, key removed)" };
// the API buckets days in UTC; show them the same way
const fmtDay = (t?: number | null) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const usd = (x: number) => (x > 0 && x < 0.01 ? "$" + Number(x.toPrecision(2)).toString() : "$" + x.toFixed(2));
const p = (x: number | null | undefined) => (x == null ? "—" : fmtMs(x) || "0 ms");

function Card({ title, def, children, wide }: { title: string; def: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`min-w-0 rounded-lg border border-line bg-surface p-5 ${wide ? "nav:col-span-2" : ""}`}>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-slate">{def}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, sub, def }: { label: string; value: ReactNode; sub?: ReactNode; def: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <p className="text-sm text-slate">{label}</p>
      <p className="mt-1 font-mono tnum text-[28px] leading-none text-ink">{value}</p>
      {sub && <p className="mt-2 font-mono tnum text-sm text-ink">{sub}</p>}
      <p className="mt-2 text-[13px] leading-snug text-slate">{def}</p>
    </div>
  );
}

const Pcts = ({ d }: { d: Dist }) =>
  d.n ? (
    <span className="whitespace-nowrap font-mono tnum">
      {p(d.p50)} <span className="text-slate">/</span> {p(d.p95)} <span className="text-slate">/</span> {p(d.p99)}
      <span className="ml-1.5 text-[12px] text-slate">n={num(d.n)}</span>
    </span>
  ) : (
    <span className="text-slate">no data</span>
  );

/** Requests per day as stacked bars: who answered, and failed requests in red on top. */
function DailyBars({ a, names }: { a: A; names: string[] }) {
  const days = a.daily || [];
  const max = Math.max(1, ...days.map((d) => d.total));
  const W = 640, H = 140, gap = days.length > 14 ? 2 : 6, bw = (W - gap * (days.length - 1)) / Math.max(1, days.length);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="block h-auto w-full" role="img" aria-label="Requests per day">
        <line x1="0" x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--line)" />
        {days.map((d, i) => {
          const x = i * (bw + gap);
          let y = H;
          const segs = names.map((n, k) => ({ n, v: d.by[n] || 0, c: COLORS[k % COLORS.length] }));
          const counted = segs.reduce((s, g) => s + g.v, 0);
          // the answered share comes from the sampled requests; scale it to the day's full answered count
          const scale = counted ? (d.total - d.failed) / counted : 0;
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${d.total.toLocaleString()} requests${d.failed ? `, ${d.failed.toLocaleString()} failed` : ""}${segs.filter((g) => g.v).map((g) => `\n${g.n}: ${g.v.toLocaleString()}`).join("")}`}</title>
              {segs.map((g) => {
                const h = ((g.v * scale) / max) * H;
                y -= h;
                return h > 0 ? <rect key={g.n} x={x} y={y} width={bw} height={h} fill={g.c} /> : null;
              })}
              {d.failed > 0 && <rect x={x} y={y - (d.failed / max) * H} width={bw} height={(d.failed / max) * H} fill="var(--stop)" />}
              {(days.length <= 7 || i % 5 === 0 || i === days.length - 1) && (
                <text x={x + bw / 2} y={H + 14} textAnchor="middle" fontSize="11" fill="var(--slate)">
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate">
        {names.map((n, k) => (
          <li key={n} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[k % COLORS.length] }} />
            {n}
          </li>
        ))}
        {days.some((d) => d.failed) && (
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--stop)" }} />
            failed
          </li>
        )}
      </ul>
    </div>
  );
}

function Bar({ label, value, of, right }: { label: ReactNode; value: number; of: number; right: ReactNode }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-ink">{label}</span>
        <span className="shrink-0 font-mono tnum text-ink">{right}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel">
        <div className="h-full rounded-full bg-go" style={{ width: `${of ? (100 * value) / of : 0}%` }} />
      </div>
    </li>
  );
}

export default function Analytics() {
  const [sp, setSp] = useSearchParams();
  const days = sp.get("days") === "30" ? 30 : 7;
  const route = sp.get("route");
  const [a, setA] = useState<A | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setA(null);
    setFailed(null);
    fetchAnalytics(days, route, ac.signal)
      .then(setA)
      .catch((e) => !ac.signal.aborted && setFailed(e instanceof Error ? e.message : "Analytics couldn't be loaded."));
    return () => ac.abort();
  }, [days, route]);
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };

  const served = (a?.answerers || []).filter((x) => !x.failed && x.requests > 0);
  const names = served.map((x) => x.name);
  const L = a?.latency;
  const hasE2e = !!L && L.e2e.n > 0;
  const routeName = route ? a?.routes.find((r) => r.id === route)?.name : null;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Route"
        value={route || ""}
        onChange={(e) => set("route", e.target.value || null)}
        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
      >
        <option value="">All routes</option>
        {(a?.routes || []).map((r) => (
          <option key={r.id} value={r.id}>
            {modelName(r.name)}
          </option>
        ))}
      </select>
      <div className="inline-flex overflow-hidden rounded-md border border-line text-sm" role="group" aria-label="Window">
        {([7, 30] as const).map((d) => (
          <button key={d} type="button" onClick={() => set("days", d === 7 ? null : "30")} className={`px-3 py-1.5 ${days === d ? "bg-panel font-medium text-ink" : "text-slate hover:text-ink"}`} aria-pressed={days === d}>
            {d} days
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Page wide>
      <PageHeader
        title="Analytics"
        description={
          <>
            How requests through Dopp went{routeName ? <> on <Link to={`/routes/${encodeURIComponent(route!)}`} className="underline decoration-line underline-offset-2 hover:text-ink">{modelName(routeName)}</Link></> : " across all your routes"} in the last {days} days (days in UTC).
          </>
        }
        action={controls}
      />
      {failed ? (
        <p className="mt-6 text-base text-slate">{failed}</p>
      ) : !a ? (
        <div className="mt-6 grid gap-4 nav:grid-cols-4">{[0, 1, 2, 3].map((i) => <span key={i} className="skel block h-28" />)}</div>
      ) : a.empty ? (
        <section className="mt-6 rounded-lg border border-line bg-surface p-6">
          <h2 className="text-base font-semibold text-ink">No requests in the last {days} days{routeName ? " on this route" : ""}</h2>
          <p className="mt-2 max-w-prose text-base text-slate">
            Once your app sends requests through a Dopp key, this page shows requests per day and who answered them, how long they took end to end
            and how much of that was the upstream call versus Dopp itself, how often a fallback fired and why, errors, confidence, how often your
            answers agree with the labels, and what it cost. Connect an app from a <Link to="/routes" className="underline decoration-line underline-offset-2 hover:text-ink">route page</Link>.
          </p>
        </section>
      ) : (
        <>
          <p className="mt-4 text-sm text-slate">
            {a.total.toLocaleString()} requests since {fmtDay(a.since)}.{" "}
            {a.capped
              ? `Latency, who answered, fallbacks and confidence come from the newest ${num(a.sample)} (since ${fmtDay(a.sample_since)}); counts, errors and cost cover every request.`
              : "Every number covers every request in the window."}{" "}
            {a.e2e_recorded_since ? (a.e2e_recorded_since > a.since ? `End-to-end time has been recorded since ${fmtDay(a.e2e_recorded_since)}; earlier requests only have handler time.` : "") : "End-to-end time isn't recorded for these requests yet; they show handler time instead."}
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 min-[560px]:grid-cols-2 nav:grid-cols-4">
            <Stat label="Requests" value={num(a.total)} sub={`${Math.round(a.total / a.days).toLocaleString()} a day on average`} def="Every request your app sent with a Dopp key, answered or not." />
            {hasE2e ? (
              <Stat label="End to end, as your app sees it" value={p(L!.e2e.p50)} sub={`p95 ${p(L!.e2e.p95)} · p99 ${p(L!.e2e.p99)}`} def="Median (p50) from Dopp receiving the request to handing back the reply. Network between your app and Dopp is not included." />
            ) : (
              <Stat label="Handler time" value={p(L?.handler.p50)} sub={`p95 ${p(L?.handler.p95)} · p99 ${p(L?.handler.p99)}`} def="Median from the key check to the reply. Not end to end: the key check itself isn't included." />
            )}
            <Stat
              label="Dopp overhead"
              value={L && L.overhead.n ? p(L.overhead.p50) : "—"}
              sub={L && L.overhead.n ? `p95 ${p(L.overhead.p95)} · p99 ${p(L.overhead.p99)}` : "not recorded yet"}
              def="End to end minus the upstream call: key check, reading the route, and building the reply."
            />
            <Stat label="Failed" value={a.errors?.rate == null ? "—" : pct1(a.errors.rate)} sub={plural(a.errors?.requests || 0, "request")} def="Requests that didn't get an answer (any reply other than 200)." />
          </div>

          <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 nav:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card wide title="Requests per day" def="Stacked by who answered; failed requests in red. Hover a day for its numbers.">
              <DailyBars a={a} names={names} />
            </Card>

            <Card
              wide
              title="Latency by who answered"
              def={
                <>
                  p50 / p95 / p99, with how many requests each is over. <b className="font-medium text-ink">End to end</b>: Dopp receiving the request to the reply.{" "}
                  <b className="font-medium text-ink">Upstream call</b>: time waiting on answerers before the reply (a fallback waits on more than one).{" "}
                  <b className="font-medium text-ink">Dopp overhead</b>: the difference. <b className="font-medium text-ink">Own call</b>: this answerer's call alone, wherever it ran.
                </>
              }
            >
              <div className="-mx-5 overflow-x-auto px-5">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="text-slate">
                    <tr className="border-b border-line">
                      <th className="py-2 pr-3 font-normal">Answered by</th>
                      <th className="py-2 pr-3 font-normal">Requests</th>
                      <th className="py-2 pr-3 font-normal">{hasE2e ? "End to end" : "Handler time"}</th>
                      <th className="py-2 pr-3 font-normal">Upstream call</th>
                      <th className="py-2 pr-3 font-normal">Dopp overhead</th>
                      <th className="py-2 font-normal">Own call</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {(a.answerers || []).map((x) => (
                      <tr key={x.name} className="align-top">
                        <td className={`py-2.5 pr-3 ${x.failed ? "text-stop" : "text-ink"}`}>{x.name}</td>
                        <td className="py-2.5 pr-3 font-mono tnum text-ink">
                          {x.requests ? num(x.requests) : <span className="text-slate">only as a step</span>}
                          {x.share != null && <span className="ml-1.5 text-slate">{pct1(x.share)}</span>}
                        </td>
                        <td className="py-2.5 pr-3">{x.requests ? <Pcts d={hasE2e ? x.e2e : x.handler} /> : <span className="text-slate">—</span>}</td>
                        <td className="py-2.5 pr-3">{x.requests ? <Pcts d={x.upstream} /> : <span className="text-slate">—</span>}</td>
                        <td className="py-2.5 pr-3">{x.requests ? <Pcts d={x.overhead} /> : <span className="text-slate">—</span>}</td>
                        <td className="py-2.5">
                          <Pcts d={x.call} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Fallbacks" def="A request fell back when the route's first answerer didn't give the answer and a later step did. Counted over answered requests.">
              {a.fallbacks && a.fallbacks.of ? (
                <>
                  <p className="font-mono tnum text-[28px] leading-none text-ink">{pct1(a.fallbacks.rate || 0)}</p>
                  <p className="mt-1 text-sm text-slate">
                    {num(a.fallbacks.requests)} of {num(a.fallbacks.of)} answered requests. The “unsure, ask the next one” step fired on {num(a.fallbacks.unsure_gate.requests)} ({pct1(a.fallbacks.unsure_gate.rate || 0)}).
                  </p>
                  <ul className="mt-4 flex flex-col gap-3">
                    {Object.entries(a.fallbacks.reasons).map(([k, v]) => (
                      <Bar key={k} label={REASON[k] || k} value={v} of={Math.max(1, ...Object.values(a.fallbacks!.reasons))} right={num(v)} />
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-slate">No answered requests yet.</p>
              )}
            </Card>

            <Card title="Confidence of the answers you got" def="For each answered request, the answerer's confidence on its least sure question. Low confidence is where a fallback to Jev pays off.">
              {a.confidence && a.confidence.n ? (
                <>
                  <svg viewBox="0 0 300 110" className="block h-auto w-full" role="img" aria-label="Confidence histogram">
                    {a.confidence.buckets.map((c, i) => {
                      const m = Math.max(1, ...a.confidence!.buckets), h = (c / m) * 90;
                      return (
                        <g key={i}>
                          <title>{`${i * 10}–${i * 10 + 10}%: ${c.toLocaleString()} requests`}</title>
                          <rect x={i * 30 + 2} y={92 - h} width={26} height={h} fill="var(--go)" />
                          <text x={i * 30 + 15} y={106} textAnchor="middle" fontSize="10" fill="var(--slate)">{i * 10}</text>
                        </g>
                      );
                    })}
                  </svg>
                  <p className="mt-1 text-sm text-slate">Percent sure, in steps of 10. {num(a.confidence.n)} requests.</p>
                </>
              ) : (
                <p className="text-sm text-slate">No confidences recorded yet.</p>
              )}
            </Card>

            <Card title="Agreement with the labels" def="Where a request has a label (your fix, or the answer of the route's labeller), the share of questions where the answer your app got matched it. The labeller isn't scored against itself.">
              {(a.answerers || []).some((x) => x.agreement) ? (
                <ul className="flex flex-col gap-3">
                  {(a.answerers || [])
                    .filter((x) => x.agreement)
                    .map((x) => (
                      <Bar key={x.name} label={x.name} value={x.agreement!.rate || 0} of={1} right={<>{x.agreement!.rate == null ? "—" : pct1(x.agreement!.rate)} <span className="text-slate">over {plural(x.agreement!.requests, "request")}</span></>} />
                    ))}
                </ul>
              ) : (
                <p className="text-sm text-slate">Nothing to compare yet: this needs requests with a label, from your fixes on Requests or from the route's labeller.</p>
              )}
            </Card>

            <Card title="Errors by status" def="Requests that got no answer, by HTTP status, with the latest message for each.">
              {a.errors && a.errors.by_status.length ? (
                <ul className="divide-y divide-line">
                  {a.errors.by_status.map((e) => (
                    <li key={e.status} className="py-2.5 text-sm">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-mono text-stop">HTTP {e.status}</span>
                        <span className="font-mono tnum text-ink">{num(e.requests)}</span>
                      </div>
                      {e.last_error && <p className="mt-1 line-clamp-2 text-slate">{e.last_error}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate">No failed requests.</p>
              )}
            </Card>

            <Card
              wide
              title="Cost"
              def={`${billingOn() ? `What you were charged, including the ${Math.round(((a.cost?.margin || 1) - 1) * 100)}% margin.` : "What it cost at the providers' list prices."} Costs are recorded per kind, not per request, so this can't be split by answerer. Per 1,000 requests counts only answering (Jev, LLMs, model GPU time). Answers on your own keys are billed by them, not here.`}
            >
              {a.cost && a.cost.daily.length ? (
                <div className="grid gap-5 nav:grid-cols-[200px_minmax(0,1fr)]">
                  <div>
                    <p className="text-sm text-slate">Per 1,000 requests</p>
                    <p className="mt-1 font-mono tnum text-[28px] leading-none text-ink">{a.cost.per_1000 == null ? "—" : usd(a.cost.per_1000)}</p>
                    <p className="mt-3 text-sm text-slate">In {a.days} days</p>
                    <p className="mt-1 font-mono tnum text-lg text-ink">{usd(a.cost.total_usd)}</p>
                  </div>
                  <ul className="flex flex-col gap-2">
                    {a.cost.daily.map((d) => {
                      const tot = Object.values(d.kinds).reduce((s, v) => s + v, 0), m = Math.max(...a.cost!.daily.map((x) => Object.values(x.kinds).reduce((s, v) => s + v, 0)));
                      return (
                        <Bar
                          key={d.day}
                          label={<>{d.day} <span className="text-slate">{Object.entries(d.kinds).map(([k, v]) => `${KIND[k] || k} ${usd(v)}`).join(" · ")}</span></>}
                          value={tot}
                          of={m}
                          right={usd(tot)}
                        />
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-slate">Nothing spent in this window.</p>
              )}
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
