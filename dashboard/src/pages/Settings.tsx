import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page, PageHeader, useMe } from "../app/AppShell";
import { QuietLink } from "../components/Button";
import { Panel } from "../components/Panel";
import { clearMe, fetchMe, signOut } from "../lib/api";
import type { Me } from "../lib/types";

/** The account. Keys to upstreams live on Upstreams; each route's keys on its page. */
export default function Settings() {
  const initial = useMe();
  const [me, setMe] = useState<Me | null>(initial);
  const nav = useNavigate();

  useEffect(() => {
    fetchMe(true).then((m) => m && setMe(m));
  }, []);

  return (
    <Page>
      <PageHeader title="Settings" description="Your account." />
      <div className="mt-5 max-w-[720px] space-y-4">
        <Panel title="Account">
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1 text-base sm:grid-cols-[140px_minmax(0,1fr)]">
            <dt className="text-sm text-slate">Signed in as</dt>
            <dd className="break-all font-mono text-ink">{me?.user.email || <span className="skel inline-block h-3.5 w-40 align-middle" />}</dd>
            <dt className="text-sm text-slate">Workspace</dt>
            <dd className="text-ink">{me?.workspace.name || "…"}</dd>
          </dl>
          <QuietLink
            className="mt-3"
            onClick={async () => {
              await signOut().catch(() => {});
              clearMe();
              nav("/");
            }}
          >
            Sign out
          </QuietLink>
        </Panel>
        <Panel title="Keys">
          <p className="text-sm text-slate">
            Keys your app uses are on each{" "}
            <Link to="/routes" className="text-accent hover:underline">
              route
            </Link>
            's page. Keys Dopp uses to reach Jev, OpenRouter and other services are on{" "}
            <Link to="/upstreams" className="text-accent hover:underline">
              Upstreams
            </Link>
            .
          </p>
        </Panel>
      </div>
    </Page>
  );
}
