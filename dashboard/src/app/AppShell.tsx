import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { cachedMe, cachedRoutes, fetchMe, fetchRoutes, onMe, onRoutes } from "../lib/api";
import { Logo, LogoMark } from "../components/Logo";
import { modelName } from "../lib/domain";
import { onboardingComplete, useOnboarding } from "../lib/onboarding";
import type { Me } from "../lib/types";

/** The signed-in identity, read from cache on first paint so the shell never flickers. */
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(cachedMe());
  useEffect(() => {
    let live = true;
    fetchMe().then((m) => live && setMe(m));
    const off = onMe((m) => live && setMe(m));
    return () => {
      live = false;
      off();
    };
  }, []);
  return me;
}

/** A tab left open across a deploy keeps running old code; tell the person instead of letting the page mislead them. */
function useNewVersion(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const mine = Array.from(document.scripts).map((x) => x.src).find((u) => /\/assets\/index-.*\.js$/.test(u)) || "";
    if (!mine) return;
    let alive = true;
    const check = async () => {
      try {
        const html = await (await fetch("/index.html", { cache: "no-store" })).text();
        const m = html.match(/\/assets\/index-[^"]+\.js/);
        if (alive && m && !mine.endsWith(m[0])) setStale(true);
      } catch {
        /* offline: nothing to say */
      }
    };
    const t = setInterval(check, 5 * 60 * 1000);
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return stale;
}

const NAV = [
  { to: "/routes", label: "Routes", hint: "Your URLs and what answers on each" },
  { to: "/requests", label: "Requests", hint: "Every request on every route" },
  { to: "/models", label: "Models", hint: "Models trained on your requests" },
  { to: "/upstreams", label: "Upstreams", hint: "Everything that can answer: Jev, LLMs, services, your models" },
  { to: "/analytics", label: "Analytics", hint: "Latency, who answered, fallbacks, errors and cost over time" },
];

const Icon = ({ d }: { d: string }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 opacity-80">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ICONS: Record<string, string> = {
  "/routes": "M2.5 4.5h7a3 3 0 0 1 0 6h-5M4.5 8.5l-2 2 2 2M11.5 2.5l2 2-2 2",
  "/requests": "M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h7",
  "/models": "M8 2 13.5 5v6L8 14 2.5 11V5L8 2Zm0 0v12M2.5 5 8 8l5.5-3",
  "/upstreams": "M8 13.5v-7M5 9.5l3-3 3 3M3 2.5h10",
  "/analytics": "M2.5 13.5h11M4.5 11V8M8 11V4M11.5 11V6.5",
};

export function AppShell({ children }: { children: ReactNode }) {
  const stale = useNewVersion();
  const me = useMe();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [routes, setRoutes] = useState(cachedRoutes());
  const onboarding = useOnboarding();
  const setupDone = onboardingComplete(onboarding);

  useEffect(() => setOpen(false), [loc.pathname, loc.search]);
  useEffect(() => onRoutes(setRoutes), []);
  // a route page opened directly: its name for the nav comes from the routes list
  useEffect(() => {
    if (!cachedRoutes()) fetchRoutes().catch(() => null);
  }, [loc.pathname]);
  // the phone menu covers the page; keep the page from scrolling underneath it
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const m = loc.pathname.match(/^\/routes\/([^/]+)/);
  const rid = m && m[1] !== "new" ? decodeURIComponent(m[1]) : null;
  const current = rid ? routes?.routes.find((r) => r.id === rid) : null;
  const section = NAV.find((n) => loc.pathname === n.to || loc.pathname.startsWith(n.to + "/"));

  const item = (active: boolean) =>
    `flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-base transition-colors ${
      active ? "bg-panel font-medium text-ink" : "text-slate hover:bg-panel hover:text-ink"
    }`;

  const links = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {onboarding && !setupDone && (
        <NavLink to="/start" className={({ isActive }) => `${item(isActive)} mb-1`}>
          <span className="h-2 w-2 shrink-0 rounded-full bg-go" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Getting started</span>
          <span className="shrink-0 font-mono text-xs text-slate">
            {onboarding.done_count} of {onboarding.total}
          </span>
        </NavLink>
      )}
      {NAV.map((n) => (
        <div key={n.to}>
          <NavLink to={n.to} className={({ isActive }) => item(isActive && !(n.to === "/routes" && rid))}>
            <Icon d={ICONS[n.to]} />
            {n.label}
          </NavLink>
          {n.to === "/routes" && rid && (
            <div className="mb-1 ml-[17px] mt-0.5 border-l border-line pl-2">
              <NavLink
                to={`/routes/${encodeURIComponent(rid)}`}
                end
                className={({ isActive }) => `nav-sub block truncate rounded-md py-1.5 pl-3 pr-2.5 text-[14px] ${isActive || loc.pathname.startsWith(`/routes/${encodeURIComponent(rid)}/`) ? "nav-sub-on bg-panel font-medium text-ink" : "text-slate hover:bg-panel hover:text-ink"}`}
                title={current?.name}
              >
                {current ? modelName(current.name) : <span className="skel inline-block h-3 w-24 align-middle" />}
              </NavLink>
            </div>
          )}
        </div>
      ))}
      <div className="my-2.5 border-t border-line" />
      <NavLink to="/usage" className={({ isActive }) => item(isActive)}>
        Usage
      </NavLink>
      <NavLink to="/settings" className={({ isActive }) => item(isActive)}>
        Settings
      </NavLink>
      {setupDone && (
        <NavLink to="/start" className={({ isActive }) => item(isActive)}>
          Getting started
        </NavLink>
      )}
      <a href="/docs.md" target="_blank" rel="noopener" className={item(false)}>
        API docs <span aria-hidden="true">↗</span>
      </a>
    </nav>
  );

  const identity = me ? (
    <NavLink to="/settings" className="flex min-w-0 items-center gap-2.5 border-t border-line px-3 py-3 hover:bg-panel" title="Account">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-go-soft text-xs font-semibold uppercase text-go">
        {me.user.email.slice(0, 1)}
      </span>
      <p className="truncate text-sm text-slate" title={me.user.email}>
        {me.user.email}
      </p>
    </NavLink>
  ) : (
    <div className="border-t border-line px-3 py-3.5">
      <span className="skel h-2.5 w-32" />
    </div>
  );

  return (
    <div className="min-h-screen nav:grid nav:grid-cols-[220px_minmax(0,1fr)]">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface nav:flex">
        <div className="px-3.5 pb-3 pt-4">
          <NavLink to="/routes" aria-label="Dopp: routes">
            <Logo size={19} />
          </NavLink>
        </div>
        <div className="flex-1 overflow-y-auto px-2">{links}</div>
        {identity}
      </aside>

      {/* phone: top bar + a menu that slides over the page */}
      <div className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur nav:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-2.5">
            <NavLink to="/routes" aria-label="Dopp: routes" className="shrink-0">
              <LogoMark size={18} />
            </NavLink>
            <span className="truncate text-base font-semibold text-ink">{current ? modelName(current.name) : section ? section.label : "Dopp"}</span>
          </span>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label="Menu"
            onClick={() => setOpen(true)}
            className="press grid h-9 w-9 place-items-center rounded-md border border-line text-slate hover:bg-panel hover:text-ink"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
      <div className={`sheet nav:hidden ${open ? "sheet-open" : ""}`} aria-hidden={!open}>
        <button type="button" className="sheet-backdrop" aria-label="Close menu" tabIndex={-1} onClick={() => setOpen(false)} />
        <div id="mobile-nav" className="sheet-panel flex flex-col bg-surface" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <Logo size={19} />
            <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="press grid h-9 w-9 place-items-center rounded-md text-slate hover:bg-panel hover:text-ink">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2">{links}</div>
          {identity}
        </div>
      </div>

      <main className="min-w-0">
        {stale && (
          <div className="m-4 flex flex-wrap items-center gap-3 rounded-lg border border-wait/40 bg-wait-soft px-4 py-2 text-sm" role="status">
            Dopp was updated since this page loaded; what you see may be out of date.
            <button type="button" className="rounded border border-line bg-surface px-2.5 py-1 text-sm text-ink" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        )}
        <div key={loc.pathname} className="page-enter">
          {children}
        </div>
      </main>
    </div>
  );
}

/** Page header: title, one-line description, primary action. `details` folds the longer explanation behind "How this works". */
export function PageHeader({
  title,
  description,
  details,
  action,
  breadcrumb,
  tab,
}: {
  title: ReactNode;
  /** Text for the browser tab when the title isn't plain text. */
  tab?: string;
  description?: ReactNode;
  details?: ReactNode;
  action?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  // the browser tab names the page: "Routes · Dopp"
  useEffect(() => {
    const t = tab ?? (typeof title === "string" ? title : null);
    if (t) document.title = `${t} · Dopp`;
    return () => { document.title = "Dopp"; };
  }, [title, tab]);
  const [more, setMore] = useState(false);
  return (
    <header className="border-b border-line pb-4">
      {breadcrumb && <p className="mb-1 text-sm text-slate">{breadcrumb}</p>}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="page-title text-xl text-ink">{title}</h1>
          {description && (
            <p className="mt-1 max-w-[76ch] text-base text-slate">
              {description}
              {details && (
                <>
                  {" "}
                  <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="whitespace-nowrap text-sm text-accent hover:underline">
                    {more ? "Less" : "How this works"}
                  </button>
                </>
              )}
            </p>
          )}
          {details && (
            <div className={`nav-collapse ${more ? "nav-collapse-open" : ""}`}>
              <div className="overflow-hidden">
                <p className="mt-2 max-w-[76ch] border-l-2 border-line pl-3 text-sm text-slate">{details}</p>
              </div>
            </div>
          )}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
    </header>
  );
}

/** The 1200px content column every page sits in. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={`mx-auto w-full ${wide ? "max-w-[1440px]" : "max-w-content"} px-4 py-6 nav:px-6 nav:py-8`}>{children}</div>;
}

