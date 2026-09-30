/* The awake/asleep line for a trained model on the GPUs, and the switch that keeps it up (price per hour from GET /api/billing). */
import { useEffect, useState } from "react";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { fetchBilling, wakeModel } from "../lib/api";
import type { ModelInfo } from "../lib/types";

/** Whether the version on our servers is up (asleep: the next request waits while it starts), and the switch that keeps it up. */
export function ServingLine({ id, v, s, onWoke, keepAwake, onKeepAwake }: {
  id: string; v: string; s: NonNullable<ModelInfo["serving"]>; onWoke: () => void; keepAwake: boolean; onKeepAwake: (on: boolean) => Promise<void>;
}) {
  const [perHour, setPerHour] = useState<number | null>(null);
  useEffect(() => { fetchBilling().then((b) => setPerHour(b.serving_usd_per_hour)).catch(() => {}); }, []);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-sm text-slate">
      {s.awake ? (
        <>
          <span className="font-mono text-xs text-go">{v} is awake</span>
          <span>Answers in under a second. It goes to sleep {s.idle_minutes} minutes after its last request.</span>
        </>
      ) : (
        <>
          <span className="font-mono text-xs text-wait">{v} is asleep</span>
          <span>The first request wakes it, which takes about {s.wake_seconds} s; then it answers in under a second and stays awake {s.idle_minutes} minutes after each request (about $0.10 of GPU time per idle stretch).</span>
          <Button size="sm" loading={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { const r = await wakeModel(id); toast.show(`${v} is awake (took ${r.seconds} s).`); onWoke(); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>Wake {v} now</Button>
          {err && <span className="text-xs text-stop">{err}</span>}
        </>
      )}
      <label className="flex w-full cursor-pointer items-center gap-2 pt-1">
        <input type="checkbox" role="switch" aria-checked={keepAwake} className="h-4 w-4 accent-[var(--accent)]" checked={keepAwake} disabled={saving}
          onChange={async (e) => { setSaving(true); try { await onKeepAwake(e.target.checked); } finally { setSaving(false); } }} />
        <span className="text-ink">Keep {v} awake</span>
        <span>· {perHour != null ? `$${perHour.toFixed(2)} an hour` : "billed by the hour"} while on, so no request waits for it to wake{saving ? " · saving…" : ""}</span>
      </label>
    </div>
  );
}
