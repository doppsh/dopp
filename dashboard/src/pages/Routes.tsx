/* Routes: the home after sign-in. Every URL+key the account has, what answers on it, how busy it is and what it costs. */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page, PageHeader } from "../app/AppShell";
import { Badge } from "../components/Badge";
import { LinkButton } from "../components/Button";
import { CopyButton, EmptyState, ErrorState } from "../components/Bits";
import { cachedRoutes, fetchRoutes } from "../lib/api";
import { onboardingComplete, startDismissed, useOnboarding } from "../lib/onboarding";
import { ago, modelName, num, usd } from "../lib/domain";
import { useNarrow } from "../lib/project";
import type { RouteSummary, RoutesPage } from "../lib/types";

const na = <span className="text-slate" title="Not on this server yet">—</span>;

function Keys({ r }: { r: RouteSummary }) {
  const live = r.keys.filter((k) => !k.revoked_at);
  if (!r.keys.length) return <span className="text-sm text-slate">none</span>;
  return (
    <span className="flex flex-col font-mono text-xs">
      {live.slice(0, 2).map((k) => (
        <span key={k.id} className="text-ink" title={k.last_used_at ? `last used ${ago(k.last_used_at)}` : "not used yet"}>
          {k.prefix}…
        </span>
      ))}
      {live.length > 2 && <span className="text-slate">+{live.length - 2} more</span>}
      {!live.length && <span className="text-slate">all revoked</span>}
    </span>
  );
}

export default function Routes() {
  const [page, setPage] = useState<RoutesPage | null>(cachedRoutes());
  const [err, setErr] = useState<string | null>(null);
  const narrow = useNarrow(900);
  const nav = useNavigate();
  const load = useCallback(() => {
    setErr(null);
    fetchRoutes()
      .then(setPage)
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // after sign-in: Getting started while any step is left, once per browser session
  const onboarding = useOnboarding();
  useEffect(() => {
    if (onboarding && !onboardingComplete(onboarding) && !startDismissed()) nav("/start", { replace: true });
  }, [onboarding, nav]);

  const routes = page?.routes ?? null;
  const legacy = !!page?.legacy;
  const open = (r: RouteSummary) => nav(`/routes/${encodeURIComponent(r.id)}`);

  return (
    <Page wide>
      <PageHeader
        title="Routes"
        description="Each route is a URL and its keys. Your app swaps Jev's URL for it; every request is stored, and the route's setup decides who answers."
        action={
          <LinkButton to="/routes/new" variant="primary">
            New route
          </LinkButton>
        }
      />

      {page && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate">
          <span>Every route shares one URL; the key picks the route:</span>
          <code className="break-all font-mono text-ink">{page.url}</code>
          <CopyButton text={page.url} />
        </div>
      )}
      {legacy && (
        <p className="mt-2 rounded border border-wait/40 bg-wait-soft px-3 py-2 text-sm text-ink">
          This server doesn't list routes with their setup, traffic and cost yet, so only names, request totals and trained models show here. Open a route for its keys and setup.
        </p>
      )}

      <div className="mt-4">
        {err && !routes ? (
          <ErrorState title="Couldn't load your routes." detail={err} onRetry={load} />
        ) : routes && !routes.length ? (
          <EmptyState
            title="No routes yet."
            body="Make one: name it, pick what answers (Jev, an open model like JevK5, an LLM, a model you trained), and get a URL and key to put in your app."
            action={<LinkButton to="/routes/new" variant="primary">New route</LinkButton>}
          />
        ) : narrow ? (
          <ul className="space-y-2">
            {!routes
              ? [0, 1, 2].map((i) => (
                  <li key={i} className="space-y-2 rounded-lg border border-line bg-surface p-3">
                    <span className="skel h-4 w-1/3" />
                    <span className="skel h-3 w-2/3" />
                  </li>
                ))
              : routes.map((r) => (
                  <li key={r.id}>
                    <Link to={`/routes/${encodeURIComponent(r.id)}`} className="block rounded-lg border border-line bg-surface p-3 hover:border-slate">
                      <p className="flex items-baseline justify-between gap-2">
                        <b className="truncate text-base font-semibold text-ink">{modelName(r.name)}</b>
                        {r.latest_model && <Badge tone="go">{r.latest_model.name}</Badge>}
                      </p>
                      <p className="mt-0.5 break-words font-mono text-xs text-ink">{r.setup_summary || (legacy ? "" : "no setup yet")}</p>
                      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <dt className="text-slate">24h</dt>
                          <dd className="font-mono text-ink">{r.requests_24h == null ? na : num(r.requests_24h)}</dd>
                        </div>
                        <div>
                          <dt className="text-slate">total</dt>
                          <dd className="font-mono text-ink">{num(r.requests_total)}</dd>
                        </div>
                        <div>
                          <dt className="text-slate">cost 24h</dt>
                          <dd className="font-mono text-ink">{r.cost_24h_usd == null ? na : usd(r.cost_24h_usd)}</dd>
                        </div>
                      </dl>
                    </Link>
                  </li>
                ))}
          </ul>
        ) : (
          <div className="scroll-x rounded-lg border border-line bg-surface">
            <table className="w-full border-collapse text-left" style={{ minWidth: 860 }}>
              <caption className="sr-only">Your routes</caption>
              <thead>
                <tr className="bg-panel text-xs text-slate">
                  {["Route", "What answers", "Requests 24h", "Total", "Cost 24h", "Latest model", "Keys"].map((h, i) => (
                    <th key={h} scope="col" className={`whitespace-nowrap border-b border-line px-3 py-2 font-medium ${i >= 2 && i <= 4 ? "text-right" : ""}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!routes
                  ? [0, 1, 2].map((i) => (
                      <tr key={i}>
                        {Array.from({ length: 7 }).map((_, j) => (
                          <td key={j} className="border-b border-line px-3 py-3">
                            <span className="skel h-3" style={{ width: j === 1 ? "80%" : "60%" }} />
                          </td>
                        ))}
                      </tr>
                    ))
                  : routes.map((r) => (
                      <tr
                        key={r.id}
                        tabIndex={0}
                        className="cursor-pointer hover:bg-panel"
                        onClick={() => open(r)}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(r))}
                      >
                        <td className="border-b border-line px-3 py-2.5 align-top">
                          <Link to={`/routes/${encodeURIComponent(r.id)}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                            {modelName(r.name)}
                          </Link>
                          <span className="block text-2xs text-slate">made {ago(r.created_at)}</span>
                        </td>
                        <td className="max-w-[340px] border-b border-line px-3 py-2.5 align-top font-mono text-xs text-ink">
                          {r.setup_summary || (legacy ? na : <span className="text-slate">no setup yet</span>)}
                        </td>
                        <td className="border-b border-line px-3 py-2.5 text-right align-top font-mono text-sm tnum">{r.requests_24h == null ? na : num(r.requests_24h)}</td>
                        <td className="border-b border-line px-3 py-2.5 text-right align-top font-mono text-sm tnum">{num(r.requests_total)}</td>
                        <td className="border-b border-line px-3 py-2.5 text-right align-top font-mono text-sm tnum">{r.cost_24h_usd == null ? na : usd(r.cost_24h_usd)}</td>
                        <td className="border-b border-line px-3 py-2.5 align-top text-sm">
                          {r.latest_model ? <span className="text-ink">{r.latest_model.name}</span> : <span className="text-slate">none yet</span>}
                        </td>
                        <td className="border-b border-line px-3 py-2.5 align-top">{legacy ? na : <Keys r={r} />}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  );
}
