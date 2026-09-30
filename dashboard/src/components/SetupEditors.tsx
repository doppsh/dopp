/* The pieces the Setup page's drawers are made of: the answerer picker, an ordered "who is right" list, and the editors
   for a route, a training plan and the checks. They only change the draft they are given; nothing here saves. */
import { useState } from "react";
import type { ReactNode } from "react";
import { Button, QuietLink } from "./Button";
import { TextInput } from "./Bits";
import { CohortPicker, ALL } from "./Cohort";
import { AddConnectionForm } from "./Connections";
import { num, SOURCES } from "../lib/domain";
import {
  answererMeta,
  backgroundText,
  chainText,
  defaultWait,
  matchText,
  matchesEverything,
  nameOf,
  oracleText,
  OPTION_GROUPS,
  planWhen,
  usd,
} from "../lib/setup";
import { OpenRouterSearch } from "./UpstreamPicker";
import type { AnswererOption } from "../lib/setup";
import type { Cohort, Connection, QuestionSet, RouteStep, Setup, SetupPlan, SetupRoute, SetupState, Source } from "../lib/types";

const numCls = "w-16 rounded border border-line bg-surface px-1.5 py-0.5 text-center font-mono text-sm tnum";
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));

/** A small section heading inside a drawer. */
export function DrawerSection({ id, title, hint, children, action }: { id?: string; title: ReactNode; hint?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 border-t border-line pb-4 pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        {action}
      </div>
      {hint && <p className="mt-0.5 text-sm text-slate">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded text-slate hover:bg-panel hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}
const Up = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 7.5 6 4.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const Down = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const X = () => <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;

/* ---------- answerer picker ---------- */

function shortMeta(a: AnswererOption): string {
  if (!a.ready) return a.why_not || "not ready";
  const xs: string[] = [];
  if (a.p50_ms != null) xs.push(`${Math.round(a.p50_ms)} ms`);
  if (a.per_1000_usd != null) xs.push(`${usd(a.per_1000_usd)}/1k${a.measured ? "" : " list"}`);
  return xs.join(" · ");
}

/** One select, grouped Services / Your versions. Not-ready answerers are listed but can't be picked, with the reason.
    Under it: the picked one's speed and price (or why it isn't ready). */
export function AnswererSelect({
  id,
  label,
  value,
  onChange,
  options,
  exclude = [],
  showMeta = true,
  labeller = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  options: AnswererOption[];
  exclude?: string[];
  showMeta?: boolean;
  /** "who is right": you (your fixes) may be picked; you never answer a request */
  labeller?: boolean;
}) {
  options = labeller ? options : options.filter((o) => o.def.kind !== "person");
  const picked = options.find((o) => o.id === value);
  const names = [...OPTION_GROUPS, ...options.map((o) => o.group).filter((g) => !OPTION_GROUPS.includes(g))];
  const groups = [...new Set(names)].map((g) => ({ g, items: options.filter((o) => o.group === g && (o.id === value || !exclude.includes(o.id))) }));
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <select
        id={id}
        aria-label={label}
        className="w-full min-w-0 rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {!picked && <option value={value}>{value ? "an upstream that no longer exists" : "Pick one"}</option>}
        {groups
          .filter((g) => g.items.length)
          .map((g) => (
            <optgroup key={g.g} label={g.g}>
              {g.items.map((o) => {
                const m = shortMeta(o);
                return (
                  <option key={o.id} value={o.id} disabled={!o.ready && o.id !== value}>
                    {o.name}
                    {m ? ` · ${m}` : ""}
                  </option>
                );
              })}
            </optgroup>
          ))}
      </select>
      {showMeta && picked && (
        <span className={`text-2xs ${picked.ready ? "text-slate" : "text-wait"}`}>
          {picked.ready ? answererMeta(picked) : `Not ready: ${picked.why_not || "can't answer right now"}. Skipped until it can answer.`}
        </span>
      )}
    </span>
  );
}

/** "+ Add a connection", opening the form in place. */
export function AddConnectionLink({ onAdded, idPrefix }: { onAdded: (c: Connection) => void; idPrefix: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <QuietLink tone="accent" onClick={() => setOpen(true)}>
        + Add a connection
      </QuietLink>
    );
  return (
    <div className="mt-2">
      <AddConnectionForm
        idPrefix={idPrefix}
        onCancel={() => setOpen(false)}
        onAdded={(c) => {
          setOpen(false);
          onAdded(c);
        }}
      />
    </div>
  );
}

/** "+ Add an LLM from OpenRouter": search its live list, pin one to the account's catalog, then pick it anywhere. */
export function AddLlmLink({ onPinned }: { onPinned?: () => void }) {
  const [open, setOpen] = useState(false);
  if (!onPinned) return null;
  if (!open)
    return (
      <QuietLink tone="accent" onClick={() => setOpen(true)}>
        + Add an LLM from OpenRouter
      </QuietLink>
    );
  return (
    <div className="mt-2 w-full rounded-lg border border-line bg-surface p-3">
      <OpenRouterSearch
        onPinned={() => {
          setOpen(false);
          onPinned();
        }}
      />
      <Button size="sm" variant="quiet" className="mt-2" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

/* ---------- who is right: an ordered list ---------- */

export function OracleList({ idp, value, onChange, options }: { idp: string; value: string[]; onChange: (v: string[]) => void; options: AnswererOption[] }) {
  const move = (i: number, d: number) => {
    const xs = [...value];
    [xs[i], xs[i + d]] = [xs[i + d], xs[i]];
    onChange(xs);
  };
  const next = options.find((o) => o.ready && !value.includes(o.id));
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-sm text-slate">
        <span className="w-5 text-center font-mono text-xs">0</span>Your fixes always win.
      </p>
      {value.map((a, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="w-5 pt-1.5 text-center font-mono text-xs text-slate">{i + 1}</span>
          <AnswererSelect id={`${idp}-o${i}`} label={`Who is right, choice ${i + 1}`} labeller value={a} options={options} exclude={value} onChange={(x) => onChange(value.map((y, j) => (j === i ? x : y)))} />
          <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
            <Up />
          </IconButton>
          <IconButton label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
            <Down />
          </IconButton>
          <IconButton label={`Remove ${nameOf(a, options)}`} disabled={value.length === 1} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X />
          </IconButton>
        </div>
      ))}
      {next && (
        <Button size="sm" variant="quiet" onClick={() => onChange([...value, next.id])}>
          {value.length ? "+ If none of these answered, then…" : "+ Pick who is right"}
        </Button>
      )}
    </div>
  );
}

/* ---------- a route ---------- */

function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-sm transition-colors ${on ? "border-ink bg-ink text-paper" : "border-line bg-surface text-ink hover:border-slate"}`}
    >
      {children}
    </button>
  );
}

const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

function WhichRequests({ route, state, onChange }: { route: SetupRoute; state: SetupState; onChange: (r: SetupRoute) => void }) {
  const [some, setSome] = useState(!matchesEverything(route));
  const m = route.match;
  const set = (patch: Partial<SetupRoute["match"]>) => onChange({ ...route, match: { ...m, ...patch } });
  const rowCls = "flex flex-wrap items-center gap-x-2 gap-y-1.5";
  const lbl = "w-[84px] shrink-0 text-sm text-slate";
  const sources = SOURCES.filter((s) => (state.sources[s.key] || 0) > 0 || m.sources.includes(s.key));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            name={`${route.id}-which`}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
            checked={!some}
            onChange={() => {
              setSome(false);
              set({ kinds: [], keys: [], sources: [] });
            }}
          />
          Everything
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="radio" name={`${route.id}-which`} className="h-3.5 w-3.5 accent-[var(--accent)]" checked={some} onChange={() => setSome(true)} />
          Only some requests
        </label>
      </div>
      {some && (
        <div className="space-y-2 rounded-lg border border-line bg-paper p-3">
          {state.kinds.length > 0 && (
            <div className={rowCls}>
              <span className={lbl}>Kinds</span>
              {state.kinds.map((k) => (
                <Chip key={k.id} on={m.kinds.includes(k.id)} onClick={() => set({ kinds: toggle(m.kinds, k.id) })}>
                  {k.name} <span className="font-mono text-xs opacity-70">{num(k.requests)}</span>
                </Chip>
              ))}
            </div>
          )}
          {state.keys.length > 0 && (
            <div className={rowCls}>
              <span className={lbl}>Keys</span>
              {state.keys.map((k) => (
                <Chip key={k.prefix} on={m.keys.includes(k.prefix)} onClick={() => set({ keys: toggle(m.keys, k.prefix) })}>
                  <span className="font-mono">{k.prefix}…</span> <span className="font-mono text-xs opacity-70">{num(k.requests)}</span>
                </Chip>
              ))}
            </div>
          )}
          {sources.length > 0 && (
            <div className={rowCls}>
              <span className={lbl}>From</span>
              {sources.map((s) => (
                <Chip key={s.key} title={s.hint} on={m.sources.includes(s.key)} onClick={() => set({ sources: toggle(m.sources, s.key as Source) })}>
                  {s.label} <span className="font-mono text-xs opacity-70">{num(state.sources[s.key] || 0)}</span>
                </Chip>
              ))}
            </div>
          )}
          <p className="text-xs text-slate">
            {matchesEverything(route)
              ? "Nothing picked yet, so this branch takes every request."
              : `Takes: ${matchText(route, state)}. Within a row, any of them; across rows, all of them.`}
          </p>
        </div>
      )}
    </div>
  );
}

function StepEditor({
  idp,
  step,
  i,
  last,
  n,
  options,
  onChange,
  onMove,
  onRemove,
}: {
  idp: string;
  step: RouteStep;
  i: number;
  last: boolean;
  n: number;
  options: AnswererOption[];
  onChange: (s: RouteStep) => void;
  onMove: (d: number) => void;
  onRemove: () => void;
}) {
  const split = step.split;
  const ids = split ? Object.keys(split) : step.ask ? [step.ask] : [];
  const anyVersion = ids.some((x) => options.find((o) => o.id === x)?.isVersion);
  const sum = split ? Object.values(split).reduce((a, b) => a + (Number(b) || 0), 0) : 100;
  const pick = (x: string) => {
    const was = options.find((o) => o.id === step.ask);
    const now = options.find((o) => o.id === x);
    // the wait follows the answerer unless someone set it by hand
    const wait = step.wait_ms == null || step.wait_ms === defaultWait(was) ? defaultWait(now) : step.wait_ms;
    onChange({ ...step, ask: x, wait_ms: wait });
  };
  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start gap-2">
        <span className="w-5 pt-1.5 text-center font-mono text-xs text-slate">{i + 1}</span>
        <span className="pt-1 text-sm text-slate">{i === 0 ? "Ask" : "Then ask"}</span>
        {split ? (
          <span className="flex-1 pt-1 text-sm text-ink">a split between answerers</span>
        ) : (
          <AnswererSelect id={`${idp}-s${i}`} label={`Step ${i + 1}: who answers`} value={step.ask || ""} options={options} onChange={pick} />
        )}
        <IconButton label="Move step up" disabled={i === 0} onClick={() => onMove(-1)}>
          <Up />
        </IconButton>
        <IconButton label="Move step down" disabled={last} onClick={() => onMove(1)}>
          <Down />
        </IconButton>
        <IconButton label="Remove this step" disabled={n === 1} onClick={onRemove}>
          <X />
        </IconButton>
      </div>

      <div className="ml-7 mt-2 space-y-1.5 text-sm">
        {split && (
          <div className="space-y-1.5">
            {Object.entries(split).map(([a, w], j) => (
              <div key={j} className="flex items-start gap-2">
                <AnswererSelect
                  id={`${idp}-s${i}-x${j}`}
                  label={`Split ${j + 1}`}
                  value={a}
                  options={options}
                  exclude={Object.keys(split)}
                  showMeta={false}
                  onChange={(x) => onChange({ ...step, split: Object.fromEntries(Object.entries(split).map(([k, v]) => (k === a ? [x, v] : [k, v]))) })}
                />
                <label className="flex shrink-0 items-center gap-1 pt-0.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className={numCls}
                    aria-label={`Share for ${nameOf(a, options)}`}
                    value={w}
                    onChange={(e) => onChange({ ...step, split: { ...split, [a]: clamp(Number(e.target.value), 0, 100) } })}
                  />
                  %
                </label>
                <IconButton
                  label={`Take ${nameOf(a, options)} out of the split`}
                  disabled={Object.keys(split).length <= 1}
                  onClick={() => {
                    const next = { ...split };
                    delete next[a];
                    onChange({ ...step, split: next });
                  }}
                >
                  <X />
                </IconButton>
              </div>
            ))}
            <p className="flex flex-wrap items-center gap-x-3">
              <span className={`font-mono text-xs ${sum === 100 ? "text-slate" : "text-stop"}`}>adds up to {sum}%{sum === 100 ? "" : ", needs 100%"}</span>
              {options.some((o) => o.ready && !split[o.id]) && (
                <QuietLink
                  tone="accent"
                  onClick={() => {
                    const o = options.find((x) => x.ready && !(x.id in split))!;
                    onChange({ ...step, split: { ...split, [o.id]: 0 } });
                  }}
                >
                  + Add one to the split
                </QuietLink>
              )}
              <QuietLink
                onClick={() => {
                  const top = Object.entries(split).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
                  const { split: _gone, ...rest } = step;
                  onChange({ ...rest, ask: top });
                }}
              >
                Stop splitting
              </QuietLink>
            </p>
          </div>
        )}

        {!last ? (
          <label className="flex flex-wrap items-center gap-1.5">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--accent)]"
              checked={step.unsure_below != null}
              onChange={(e) => onChange({ ...step, unsure_below: e.target.checked ? 0.7 : null })}
            />
            Move on if its least sure answer is below
            <input
              type="number"
              min={1}
              max={99}
              className={numCls}
              aria-label="Sureness threshold in percent"
              disabled={step.unsure_below == null}
              value={Math.round((step.unsure_below ?? 0.7) * 100)}
              onChange={(e) => onChange({ ...step, unsure_below: clamp(Number(e.target.value), 1, 99) / 100 })}
            />
            %
          </label>
        ) : (
          <p className="text-slate">{n > 1 ? "The last step's answer is served even when it is unsure." : "Its answer is served even when it is unsure."}</p>
        )}
        <label className="flex flex-wrap items-center gap-1.5">
          {last ? "Wait up to" : "Move on if there's no answer within"}
          <input
            type="number"
            min={1}
            max={600}
            className={numCls}
            aria-label="Seconds to wait"
            value={Math.round((step.wait_ms ?? 30000) / 1000)}
            onChange={(e) => onChange({ ...step, wait_ms: clamp(Number(e.target.value), 1, 600) * 1000 })}
          />
          s{!last && ", or on an error"}
        </label>
        {anyVersion && <p className="text-xs text-slate">A sleeping model takes about 15 s to wake, so models get 90 s by default (30 s for services).</p>}
        {!split && (
          <QuietLink
            onClick={() => {
              const other = options.find((o) => o.ready && o.id !== step.ask);
              onChange({ ...step, ask: undefined, split: other ? { [step.ask || other.id]: 50, [other.id]: 50 } : { [step.ask || ""]: 100 } });
            }}
          >
            Split between answerers (A/B)
          </QuietLink>
        )}
      </div>
    </li>
  );
}

export function RouteEditor({
  route,
  state,
  options,
  onChange,
  onConnectionAdded,
  onCatalogChanged,
}: {
  route: SetupRoute;
  state: SetupState;
  options: AnswererOption[];
  onChange: (r: SetupRoute) => void;
  onConnectionAdded: (c: Connection) => void;
  onCatalogChanged?: () => void;
}) {
  const idp = `route-${route.id}`;
  const steps = route.steps;
  const setSteps = (xs: RouteStep[]) => onChange({ ...route, steps: xs });
  const oracle0 = options.find((o) => o.id === route.oracle[0]);
  const fillCost = oracle0?.per_1000_usd != null && route.fill_pct > 0 ? (oracle0.per_1000_usd * route.fill_pct) / 100 : null;
  return (
    <div>
      <DrawerSection title="Name">
        <TextInput id={`${idp}-name`} data-autofocus aria-label="Branch name" value={route.name} maxLength={60} onChange={(e) => onChange({ ...route, name: e.target.value })} />
      </DrawerSection>

      <DrawerSection title="Which requests" hint="The first branch that matches a request answers it.">
        <WhichRequests route={route} state={state} onChange={onChange} />
      </DrawerSection>

      <DrawerSection title="Who answers, in order" hint={`Now: ${chainText(route, options)}.`}>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <StepEditor
              key={i}
              idp={idp}
              step={s}
              i={i}
              n={steps.length}
              last={i === steps.length - 1}
              options={options}
              onChange={(x) => setSteps(steps.map((y, j) => (j === i ? x : y)))}
              onMove={(d) => {
                const xs = [...steps];
                [xs[i], xs[i + d]] = [xs[i + d], xs[i]];
                setSteps(xs);
              }}
              onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {(() => {
            const used = new Set(steps.flatMap((s) => (s.split ? Object.keys(s.split) : s.ask ? [s.ask] : [])));
            const next = options.find((o) => o.ready && !used.has(o.id));
            return next ? (
              <Button size="sm" variant="quiet" onClick={() => setSteps([...steps, { ask: next.id, wait_ms: defaultWait(next) }])}>
                + Then ask…
              </Button>
            ) : null;
          })()}
          <AddConnectionLink idPrefix={`${idp}-conn-a`} onAdded={onConnectionAdded} />
          <AddLlmLink onPinned={onCatalogChanged} />
        </div>
      </DrawerSection>

      <DrawerSection title="Also ask in the background" hint="After the reply is sent. Their answers land on the same request, to compare and to train on.">
        {route.background.length ? (
          <ul className="space-y-2">
            {route.background.map((b, i) => (
              <li key={i} className="flex items-start gap-2">
                <AnswererSelect
                  id={`${idp}-b${i}`}
                  label={`Background ${i + 1}`}
                  value={b.ask}
                  options={options}
                  exclude={route.background.map((x) => x.ask)}
                  onChange={(x) => onChange({ ...route, background: route.background.map((y, j) => (j === i ? { ...y, ask: x } : y)) })}
                />
                <label className="flex shrink-0 items-center gap-1 pt-0.5 text-sm text-slate">
                  on
                  <input
                    type="number"
                    min={1}
                    max={100}
                    className={numCls}
                    aria-label="Percent of requests"
                    value={b.pct}
                    onChange={(e) => onChange({ ...route, background: route.background.map((y, j) => (j === i ? { ...y, pct: clamp(Number(e.target.value), 1, 100) } : y)) })}
                  />
                  %
                </label>
                <IconButton label={`Stop asking ${nameOf(b.ask, options)} in the background`} onClick={() => onChange({ ...route, background: route.background.filter((_, j) => j !== i) })}>
                  <X />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate">Nobody. Only the answer that is served is kept.</p>
        )}
        {(() => {
          const next = options.find((o) => !route.background.some((b) => b.ask === o.id) && o.isVersion) || options.find((o) => !route.background.some((b) => b.ask === o.id));
          return next ? (
            <Button size="sm" variant="quiet" className="mt-1" onClick={() => onChange({ ...route, background: [...route.background, { ask: next.id, pct: 100 }] })}>
              + Also ask…
            </Button>
          ) : null;
        })()}
      </DrawerSection>

      <DrawerSection id={`${idp}-oracle`} title="Who is right (oracle)" hint="The answer these requests train on: the first of these that answered.">
        <OracleList idp={idp} value={route.oracle} options={options} onChange={(xs) => onChange({ ...route, oracle: xs })} />
        {oracle0 && (
          <label className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
            If {oracle0.name} didn't answer, ask it after the reply on
            <input
              type="number"
              min={0}
              max={100}
              className={numCls}
              aria-label="Percent of requests to ask later"
              value={route.fill_pct}
              onChange={(e) => onChange({ ...route, fill_pct: clamp(Number(e.target.value), 0, 100) })}
            />
            % of requests
            <span className="w-full text-xs text-slate">
              So they get a label to train on.
              {fillCost != null && ` About ${usd(fillCost)} per 1,000 requests${oracle0.measured ? "" : " (from its list price)"}.`}
            </span>
          </label>
        )}
        <div className="mt-2">
          <AddConnectionLink idPrefix={`${idp}-conn-o`} onAdded={onConnectionAdded} />
        </div>
      </DrawerSection>

      <DrawerSection title="More">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 h-3.5 w-3.5 accent-[var(--accent)]" checked={route.allow_header} onChange={(e) => onChange({ ...route, allow_header: e.target.checked })} />
          <span>
            <span className="text-ink">
              Let callers pick the upstream per request (the <code className="font-mono">model</code> field or the <code className="font-mono">x-dopp-target</code> header)
            </span>
            <span className="block text-slate">
              Like OpenRouter: a request that names an upstream id, e.g.{" "}
              <code className="break-all font-mono">"model": "{(options.find((o) => o.group === "LLMs" && o.ready) || options.find((o) => o.ready && o.id !== route.steps[0]?.ask) || options[0])?.id || "jev"}"</code>, is answered by it instead of step 1.
            </span>
          </span>
        </label>
        <label className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--accent)]"
            checked={route.cache_s != null}
            onChange={(e) => onChange({ ...route, cache_s: e.target.checked ? 3600 : null })}
          />
          Reuse identical replies for
          <input
            type="number"
            min={1}
            className={`${numCls} w-20`}
            aria-label="Seconds to reuse a reply"
            disabled={route.cache_s == null}
            value={route.cache_s ?? 3600}
            onChange={(e) => onChange({ ...route, cache_s: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
          />
          s
        </label>
      </DrawerSection>
    </div>
  );
}

/* ---------- a training plan ---------- */

export function PlanEditor({
  projectId,
  plan,
  state,
  options,
  modelLabel,
  defaultOracle,
  onChange,
}: {
  projectId: string;
  plan: SetupPlan;
  state: SetupState;
  options: AnswererOption[];
  modelLabel: string;
  /** what an override starts from: the routes' own oracle */
  defaultOracle: string[];
  onChange: (p: SetupPlan) => void;
}) {
  const idp = `plan-${plan.id}`;
  // the kinds as the cohort picker reads them: a name and a count
  const sets = state.kinds.map((k) => ({ id: k.id, name: k.name, questions: [], readiness: { calls: k.requests } }) as QuestionSet);
  const cohort: Cohort = { ...ALL, ...(plan.cohort || {}) };
  const auto = plan.auto;
  return (
    <div>
      <DrawerSection title="Name">
        <TextInput id={`${idp}-name`} data-autofocus aria-label="Plan name" value={plan.name} maxLength={40} onChange={(e) => onChange({ ...plan, name: e.target.value })} />
      </DrawerSection>

      <DrawerSection title="Base" hint="The model each version is fine-tuned from.">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <select aria-label="Base" className="rounded border border-line bg-surface px-2 py-1 text-sm" value={plan.base} onChange={(e) => onChange({ ...plan, base: e.target.value })}>
            {!state.bases.some((b) => b.id === plan.base) && <option value={plan.base}>a base this server no longer offers</option>}
            {state.bases.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {plan.base === "tiny" ? (
            <span className="text-sm text-slate">Epochs: picked by the trainer from how many requests there are</span>
          ) : (
          <label className="flex items-center gap-1.5 text-slate">
            Epochs
            <select aria-label="Epochs: passes over the requests" className="rounded border border-line bg-surface px-2 py-1 font-mono text-sm text-ink" value={plan.epochs} onChange={(e) => onChange({ ...plan, epochs: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          )}
        </div>
      </DrawerSection>

      <DrawerSection title="Which requests">
        <CohortPicker
          projectId={projectId}
          value={cohort}
          onChange={(c) => {
            const next = { sources: c.sources || [], keys: c.keys || [], schemas: c.schemas || [], since: c.since ?? null, until: c.until ?? null };
            const all = !next.sources.length && !next.keys.length && !next.schemas.length && next.since == null && next.until == null;
            onChange({ ...plan, cohort: all ? null : next });
          }}
          sets={sets}
          keys={state.keys.map((k) => k.prefix)}
          counts={state.sources}
          modelLabel={modelLabel}
          hasVersion={false}
        />
      </DrawerSection>

      <DrawerSection title="Labels: who is right">
        <div className="space-y-1 text-sm">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="radio" name={`${idp}-labels`} className="h-3.5 w-3.5 accent-[var(--accent)]" checked={!plan.oracle} onChange={() => onChange({ ...plan, oracle: null })} />
            From each request's branch (default)
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="radio" name={`${idp}-labels`} className="h-3.5 w-3.5 accent-[var(--accent)]" checked={!!plan.oracle} onChange={() => onChange({ ...plan, oracle: plan.oracle || [...defaultOracle] })} />
            Override for this plan only
          </label>
        </div>
        {plan.oracle && (
          <div className="mt-2">
            <OracleList idp={idp} value={plan.oracle} options={options} onChange={(xs) => onChange({ ...plan, oracle: xs })} />
          </div>
        )}
      </DrawerSection>

      <DrawerSection title="When">
        <div className="space-y-1 text-sm">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="radio" name={`${idp}-when`} className="h-3.5 w-3.5 accent-[var(--accent)]" checked={!auto} onChange={() => onChange({ ...plan, auto: null })} />
            By hand, from Models
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name={`${idp}-when`}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
              checked={!!auto}
              onChange={() => onChange({ ...plan, auto: auto || { first_at: 100, every: 100, until_agreement: true } })}
            />
            Automatically
          </label>
        </div>
        {auto && (
          <div className="ml-5 mt-2 space-y-1.5 text-sm">
            <label className="flex flex-wrap items-center gap-1.5">
              First at
              <input type="number" min={1} className={`${numCls} w-20`} aria-label="First training at this many labelled requests" value={auto.first_at} onChange={(e) => onChange({ ...plan, auto: { ...auto, first_at: Math.max(1, Math.round(Number(e.target.value) || 1)) } })} />
              labelled requests, then every
              <input type="number" min={1} className={`${numCls} w-20`} aria-label="Then every this many more" value={auto.every} onChange={(e) => onChange({ ...plan, auto: { ...auto, every: Math.max(1, Math.round(Number(e.target.value) || 1)) } })} />
              more
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={auto.until_agreement} onChange={(e) => onChange({ ...plan, auto: { ...auto, until_agreement: e.target.checked } })} />
              Only while live agreement is below the switch bar
            </label>
            <p className="text-xs text-slate">Each run costs the same as a training you start by hand; Models shows the price first.</p>
          </div>
        )}
      </DrawerSection>
    </div>
  );
}

/* ---------- checks ---------- */

export function ChecksEditor({ setup, options, onChange }: { setup: Setup; options: AnswererOption[]; onChange: (s: Setup) => void }) {
  return (
    <DrawerSection title="Checker" hint="Judges whether generated requests read like real ones, and how well a public dataset fits your requests.">
      <AnswererSelect id="checker" label="Checker" value={setup.checker} options={options} onChange={(x) => onChange({ ...setup, checker: x })} />
    </DrawerSection>
  );
}

/* ---------- a whole setup, read-only (history) ---------- */

export function SetupSummary({ setup, state, options }: { setup: Setup; state: SetupState; options: AnswererOption[] }) {
  const row = "grid grid-cols-[88px_minmax(0,1fr)] gap-2 border-t border-line py-1.5 text-sm first:border-t-0";
  const base = (id: string) => state.bases.find((b) => b.id === id)?.name || id;
  return (
    <div className="rounded-lg border border-line bg-paper px-3 py-1">
      {setup.routes.map((r) => (
        <div key={r.id} className={row}>
          <span className="text-xs text-slate">branch</span>
          <span className="min-w-0">
            <b className="font-medium text-ink">{r.name}</b> <span className="text-slate">· {matchText(r, state)}</span>
            <span className="block font-mono text-xs text-ink">{chainText(r, options)}</span>
            {r.background.length > 0 && <span className="block font-mono text-xs text-slate">background: {backgroundText(r, options)}</span>}
            <span className="block font-mono text-xs text-slate">
              who is right: {oracleText(r.oracle, options)}
              {r.fill_pct ? ` · ask later for ${r.fill_pct}%` : ""}
            </span>
          </span>
        </div>
      ))}
      {setup.plans.map((p) => (
        <div key={p.id} className={row}>
          <span className="text-xs text-slate">plan</span>
          <span className="min-w-0">
            <b className="font-medium text-ink">{p.name}</b> <span className="text-slate">· {base(p.base)} · {planWhen(p)}</span>
            {p.oracle && <span className="block font-mono text-xs text-accent">labels: {oracleText(p.oracle, options)}</span>}
          </span>
        </div>
      ))}
      <div className={row}>
        <span className="text-xs text-slate">checks</span>
        <span className="text-sm">{nameOf(setup.checker, options)}</span>
      </div>
    </div>
  );
}

