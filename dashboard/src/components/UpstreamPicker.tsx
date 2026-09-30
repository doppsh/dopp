/* Pick an upstream from the account's catalog: a searchable list grouped Jev · LLMs · Your models · Services, each with its
   price per 1,000 and speed (measured, or marked as a list price / guess). LLMs not in the catalog yet can be found on
   OpenRouter and added in place. Used by New route, Requests' batch actions, Models' "labels from". */
import { useEffect, useMemo, useState } from "react";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { isMissing, pinUpstream, searchUpstreams } from "../lib/api";
import { usd } from "../lib/domain";
import { GROUPS, benchText, groupOf, keyText, priceText, speedText } from "../lib/upstreams";
import type { Group } from "../lib/upstreams";
import type { SearchedModel, Upstream } from "../lib/types";

const inputCls = "w-full rounded border border-line bg-surface px-2.5 py-1.5 text-base text-ink placeholder:text-slate focus-visible:border-accent";

/** OpenRouter's live model list, searchable; "Add" pins one to the account's catalog. */
export function OpenRouterSearch({ initial = "", onPinned, pinned = [] }: { initial?: string; onPinned: (id: string) => void; pinned?: string[] }) {
  const [q, setQ] = useState(initial);
  const [res, setRes] = useState<{ models: SearchedModel[] | null; err: string | null; missing: boolean }>({ models: null, err: null, missing: false });
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setQ(initial), [initial]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRes({ models: null, err: null, missing: false });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchUpstreams("openrouter", term, ctrl.signal)
        .then((r) => setRes({ models: r.models, err: null, missing: false }))
        .catch((e) => !ctrl.signal.aborted && setRes({ models: null, err: (e as Error).message, missing: isMissing(e) }));
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);
  return (
    <div>
      <label className="block text-sm font-medium text-ink" htmlFor="or-search">
        Find an LLM on OpenRouter
      </label>
      <input id="or-search" className={`${inputCls} mt-1`} placeholder="claude, gpt, llama, gemini…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2 text-sm" aria-live="polite">
        {res.missing ? (
          <p className="text-slate">Searching OpenRouter isn't available on this server yet.</p>
        ) : res.err ? (
          <p className="text-stop">{res.err}</p>
        ) : res.models === null ? (
          q.trim().length >= 2 ? <span className="skel h-4 w-2/3" /> : <p className="text-slate">Type at least two letters.</p>
        ) : !res.models.length ? (
          <p className="text-slate">No OpenRouter model matches “{q.trim()}”.</p>
        ) : (
          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded border border-line">
            {res.models.slice(0, 40).map((m) => {
              const have = pinned.includes(m.id);
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink" title={m.id}>{m.name}</span>
                    <span className="block font-mono text-2xs text-slate">
                      {m.per_1000_est_usd != null ? `~${usd(m.per_1000_est_usd)} per 1,000 (list price, estimated)` : "no price listed"}
                      {m.per_1m_in_usd != null && ` · $${m.per_1m_in_usd}/M in`}
                      {m.per_1m_out_usd != null && ` · $${m.per_1m_out_usd}/M out`}
                      {m.context ? ` · ${Math.round(m.context / 1000)}k context` : ""}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    disabled={have}
                    loading={busy === m.id}
                    onClick={async () => {
                      setBusy(m.id);
                      try {
                        await pinUpstream(m.id);
                        onPinned(m.id);
                      } catch (e) {
                        setRes((r) => ({ ...r, err: (e as Error).message }));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {have ? "In your list" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export interface FallbackOption {
  id: string;
  name: string;
  note?: string;
}

/** The catalog as a list you pick one from. */
export function UpstreamPicker({
  upstreams,
  missing,
  fallback = [],
  value,
  onPick,
  exclude = [],
  onCatalogChanged,
  canSearchOpenRouter = true,
  maxHeight = 360,
  note,
}: {
  upstreams: Upstream[] | null;
  missing?: boolean;
  /** when the catalog isn't on this server yet: what else we know answers (a route's setup, the requests' answers) */
  fallback?: FallbackOption[];
  value: string | null;
  onPick: (id: string, u: Upstream | null) => void;
  exclude?: string[];
  onCatalogChanged?: () => void;
  canSearchOpenRouter?: boolean;
  maxHeight?: number;
  /** a line under a row: e.g. why it can't be picked here */
  note?: (u: Upstream) => string | null;
}) {
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const term = q.trim().toLowerCase();
  const shown = useMemo(
    () => (upstreams || []).filter((u) => !exclude.includes(u.id) && (!term || `${u.name} ${u.provider} ${u.id}`.toLowerCase().includes(term))),
    [upstreams, exclude, term],
  );
  const by = (g: Group) => shown.filter((u) => groupOf(u.kind) === g);

  if (missing) {
    const fb = fallback.filter((f) => !exclude.includes(f.id));
    return (
      <div>
        <p className="mb-2 text-sm text-wait">The full upstream catalog isn't available on this server yet. These are the ones already answering here:</p>
        {fb.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {fb.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  aria-pressed={value === f.id}
                  onClick={() => onPick(f.id, null)}
                  className={`flex w-full flex-wrap items-baseline gap-x-2 px-3 py-2 text-left text-sm hover:bg-panel ${value === f.id ? "bg-accent-soft" : ""}`}
                >
                  <span className="text-ink">{f.name}</span>
                  {f.note && <span className="text-xs text-slate">{f.note}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate">Nothing to pick from yet.</p>
        )}
      </div>
    );
  }

  if (!upstreams)
    return (
      <div className="space-y-2" aria-busy="true">
        <span className="skel h-8 w-full" />
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skel h-10 w-full" />
        ))}
      </div>
    );

  return (
    <div className="min-w-0">
      <input className={inputCls} placeholder="Search upstreams" aria-label="Search upstreams" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2 overflow-y-auto rounded-lg border border-line" style={{ maxHeight }}>
        {GROUPS.map((g) => {
          const items = by(g);
          const llm = g === "LLMs";
          if (!items.length && !(llm && canSearchOpenRouter && onCatalogChanged)) return null;
          return (
            <section key={g} aria-label={g} className="border-b border-line last:border-b-0">
              <h3 className="sticky top-0 z-[1] flex items-baseline justify-between bg-panel px-3 py-1 text-xs font-medium text-slate">
                <span>{g}</span>
                <span className="font-mono tnum">{items.length}</span>
              </h3>
              <ul>
                {items.map((u) => {
                  const on = value === u.id;
                  const extra = note?.(u) ?? null;
                  return (
                    <li key={u.id} className="border-t border-line first:border-t-0">
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={!u.ready}
                        onClick={() => onPick(u.id, u)}
                        title={u.ready ? u.id : u.why_not || "can't answer right now"}
                        className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-3 py-2 text-left hover:bg-panel disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent ${on ? "bg-accent-soft shadow-[inset_3px_0_0_var(--accent)]" : ""}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{u.name}</span>
                          <span className="block truncate text-2xs text-slate">
                            {u.kind === "open" ? `${u.license || "open weights"}${u.note ? ` · ${u.note}` : ""}` : u.provider}
                            {u.jevbench != null && ` · ${benchText(u)}`}
                            {u.kind !== "model" && u.kind !== "open" && ` · ${keyText(u.key)}`}
                            {u.kind === "model" && u.route_name ? ` · trained on ${u.route_name}` : ""}
                            {!u.ready && <span className="text-wait"> · {u.why_not || "not ready"}</span>}
                            {extra && <span className="text-wait"> · {extra}</span>}
                          </span>
                        </span>
                        <span className="text-right font-mono text-2xs leading-relaxed text-slate">
                          <span className="block" title={u.price_note || undefined}>{priceText(u, true) || "—"}</span>
                          <span className="block">{speedText(u, true)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {llm && canSearchOpenRouter && onCatalogChanged && (
                  <li className="border-t border-line px-3 py-2">
                    {searching ? (
                      <div>
                        <OpenRouterSearch
                          initial={q}
                          pinned={(upstreams || []).map((u) => u.id)}
                          onPinned={(id) => {
                            setSearching(false);
                            onCatalogChanged();
                            onPick(id, null);
                          }}
                        />
                        <Button size="sm" variant="quiet" className="mt-1" onClick={() => setSearching(false)}>
                          Close
                        </Button>
                      </div>
                    ) : (
                      <button type="button" className="text-sm text-accent hover:underline" onClick={() => setSearching(true)}>
                        + More LLMs: search OpenRouter{q.trim() ? ` for “${q.trim()}”` : ""}
                      </button>
                    )}
                  </li>
                )}
              </ul>
            </section>
          );
        })}
        {!shown.length && !onCatalogChanged && <p className="px-3 py-4 text-sm text-slate">Nothing matches “{q.trim()}”.</p>}
      </div>
      <p className="mt-1.5 text-2xs text-slate">
        Prices and times are measured on your requests where there is history; <Badge className="!py-0 !text-2xs">list</Badge> marks a provider's list price, and ~ a guessed time.
      </p>
    </div>
  );
}
