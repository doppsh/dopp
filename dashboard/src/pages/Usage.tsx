import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Page, PageHeader } from "../app/AppShell";
import { BillingSection } from "../components/Billing";
import { fetchUsage } from "../lib/api";
import { modelName } from "../lib/domain";
import type { Usage as UsageT } from "../lib/types";
import { billingOn, ourKey } from "../lib/server";

const kindName = (k: string) => ({ jev: `Jev answers (${ourKey(billingOn())})`, generator: "Writer, GEN_API_KEY (writing requests, labels, describing setups)", training: "Training (GPU)", llm: `LLM answers (${ourKey(billingOn())})`, serving: "Models answering (GPU time)" } as Record<string, string>)[k];
// small amounts keep two significant digits instead of rounding to $0.00
const usd = (x: number) => (x > 0 && x < 0.01 ? "$" + Number(x.toPrecision(2)).toString() : "$" + x.toFixed(2));

/** Everything this account has used, all models together: the total, by model, and by kind. */
export default function Usage() {
  const [u, setU] = useState<UsageT | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetchUsage().then(setU).catch(() => setFailed(true));
  }, []);
  const top = Math.max(0.0001, ...(u?.by_project ?? []).map((p) => p.used));
  return (
    <Page>
      <PageHeader title="Usage" description={billingOn() ? "Your credit, hosting, and what answering, writing requests and training have cost, across all your routes." : "What answering, writing requests and training have cost, across all your routes."} />
      {failed ? (
        <p className="mt-6 text-base text-slate">Usage couldn't be loaded. Try again in a moment.</p>
      ) : (
        <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-5 nav:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <BillingSection />
          <section className="rounded-lg border border-line bg-surface p-5 nav:col-span-2">
            <p className="text-sm text-slate">Used so far</p>
            {u ? <p className="mt-1 font-mono tnum text-[40px] leading-none text-ink">{usd(u.used)}</p> : <span className="skel mt-2 block h-9 w-28" />}
            {u && (
              <p className="mt-3 text-sm text-slate">
                {billingOn() || u.margin > 1 ? `Prices include a ${Math.round((u.margin - 1) * 100)}% margin.` : "At the providers' list prices."} Answers on your own keys (your TypeSafe or OpenRouter key) are billed by them, not here.
                {u.on_us && u.on_us.calls > 0 ? ` ${billingOn() ? "On us, not billed" : "Done by the product on its own, not counted above"}: ${u.on_us.what} (${u.on_us.calls.toLocaleString()} ${u.on_us.calls === 1 ? "call" : "calls"}, ${usd(u.on_us.usd)}).` : ""}
                {u.unmetered.length ? ` Not counted yet: ${u.unmetered.join("; ")}.` : ""}
              </p>
            )}
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="text-base font-semibold text-ink">By route</h2>
            <ul className="mt-3 flex flex-col gap-3">
              {!u && [0, 1, 2].map((i) => <li key={i} className="skel h-8" />)}
              {u && !u.by_project.length && <li className="text-sm text-slate">Nothing used yet.</li>}
              {u?.by_project
                .slice()
                .sort((a, b) => b.used - a.used)
                .map((p) => (
                  <li key={p.id}>
                    <div className="flex items-baseline justify-between gap-3 text-base">
                      <Link to={`/routes/${encodeURIComponent(p.id)}`} className="truncate text-ink hover:underline">
                        {modelName(p.name)}
                      </Link>
                      <span className="font-mono tnum text-sm text-ink">{usd(p.used)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel">
                      <div className="bar-grow h-full rounded-full bg-go" style={{ width: `${(100 * p.used) / top}%` }} />
                    </div>
                  </li>
                ))}
            </ul>
          </section>

          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="text-base font-semibold text-ink">By kind</h2>
            <ul className="mt-3 divide-y divide-line">
              {!u && [0, 1, 2].map((i) => <li key={i} className="skel my-2 h-6" />)}
              {u && !u.lines.length && <li className="py-2.5 text-sm text-slate">Nothing used yet.</li>}
              {u?.lines.map((l) => (
                <li key={l.kind} className="flex items-baseline justify-between gap-3 py-2.5 text-base">
                  <span className="text-ink">
                    {kindName(l.kind) || l.kind}
                    <span className="ml-2 text-sm text-slate">{l.calls.toLocaleString()} {l.calls === 1 ? "call" : "calls"}</span>
                  </span>
                  <span className="font-mono tnum text-sm text-ink">{usd(l.usd)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Page>
  );
}
