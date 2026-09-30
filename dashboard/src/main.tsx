import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import "./styles.css";
import { AppShell, Page, PageHeader } from "./app/AppShell";
import { EmptyState } from "./components/Bits";
import { LinkButton } from "./components/Button";
import { ToastHost } from "./components/Toast";
import { cachedMe, fetchMe, setUnauthorizedHandler } from "./lib/api";
import { billingOn, fetchServer } from "./lib/server";

import Landing from "./pages/Landing";
import SignIn from "./pages/SignIn";
import RoutesPage from "./pages/Routes";
import NewRoute from "./pages/NewRoute";
import RoutePage from "./pages/Route";
import Analytics from "./pages/Analytics";
import Try from "./pages/Try";
import Requests from "./pages/Requests";
import Models from "./pages/Models";
import Upstreams from "./pages/Upstreams";
import Usage from "./pages/Usage";
import Settings from "./pages/Settings";
import Start from "./pages/Start";

/** Everything signed-in sits in the shell; a 401 anywhere bounces to /signin. */
function Protected() {
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    setUnauthorizedHandler(() => nav("/signin", { replace: true }));
    if (!cachedMe()) {
      fetchMe().then((m) => {
        if (!m) nav("/signin", { replace: true });
      });
    }
  }, [nav, loc.pathname]);
  useEffect(() => {
    fetchMe(true);
  }, []);
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

/** Old per-model pages (/m/:id/…, /p/:id/…) → the matching new page. */
function FromOld() {
  const { id = "", sub = "" } = useParams();
  const [params] = useSearchParams();
  const e = encodeURIComponent(id);
  const q = new URLSearchParams(params);
  if (["requests", "examples", "data", "calls"].includes(sub)) {
    q.set("route", id);
    return <Navigate to={`/requests?${q.toString()}`} replace />;
  }
  if (["train", "model"].includes(sub)) return <Navigate to={`/models?route=${e}`} replace />;
  if (sub === "try") return <Navigate to={`/routes/${e}/try`} replace />;
  const rest = q.toString();
  return <Navigate to={`/routes/${e}${rest ? "?" + rest : ""}`} replace />;
}

function NotFound() {
  return (
    <Page>
      <PageHeader title="Not found" description="That page doesn't exist." />
      <div className="mt-6">
        <EmptyState title="Nothing here." body="Check the link, or pick a page on the left." action={<LinkButton to="/routes" variant="primary">Your routes</LinkButton>} />
      </div>
    </Page>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <ToastHost>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/how" element={<Navigate to="/#how" replace />} />
          <Route path="/pricing" element={<Navigate to="/" replace />} />
          <Route path="/signin" element={<SignIn />} />

          <Route element={<Protected />}>
            <Route path="/start" element={<Start />} />
            <Route path="/routes" element={<RoutesPage />} />
            <Route path="/routes/new" element={<NewRoute />} />
            <Route path="/routes/:id" element={<RoutePage />} />
            <Route path="/routes/:id/try" element={<Try />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/models" element={<Models />} />
            <Route path="/upstreams" element={<Upstreams />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/settings" element={<Settings />} />

            {/* the old dashboard's addresses */}
            <Route path="/m/:id" element={<FromOld />} />
            <Route path="/m/:id/:sub" element={<FromOld />} />
            <Route path="/p/:id" element={<FromOld />} />
            <Route path="/p/:id/:sub" element={<FromOld />} />
            <Route path="/new" element={<Navigate to="/routes/new" replace />} />
            {["/app", "/app/*", "/projects", "/calls", "/connect", "/glossary"].map((p) => (
              <Route key={p} path={p} element={<Navigate to="/routes" replace />} />
            ))}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </ToastHost>
    </BrowserRouter>
  );
}

// after a deploy, a tab opened before it asks for chunks that no longer exist; reload once instead of showing a blank page
window.addEventListener("vite:preloadError", (e) => { e.preventDefault(); const k = "dopp-reloaded"; if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, "1"); location.reload(); } });
// same for the stylesheet: an open tab whose CSS a deploy removed renders unstyled; reload once instead
for (const l of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) l.addEventListener("error", () => { const k = "dopp-reloaded-css"; if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, "1"); location.reload(); } }, { once: true });   // stylesheet-failed
const root = createRoot(document.getElementById("root")!);
const draw = () => root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
draw();
// what kind of server this is (lib/server.ts): drawn again once known, so wording about credits matches the server
const before = billingOn();
fetchServer().then(() => { if (billingOn() !== before) draw(); });
