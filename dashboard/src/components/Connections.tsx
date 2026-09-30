/* Connections: keys to outside upstreams the account plugs in once, for every route. Jev is built in (the server's key, or
   yours); any URL that speaks Jev's API can be added. Upstreams lists them; a route's setup can add
   one in place. */
import { useEffect, useState } from "react";
import { Button, QuietLink } from "./Button";
import { Field, Radio, TextInput } from "./Bits";
import { useToast } from "./Toast";
import { addConnection, deleteConnection, setJevConnection } from "../lib/api";
import type { Connection } from "../lib/types";
import { billingOn, ourKey } from "../lib/server";

export function AddConnectionForm({ onAdded, onCancel, idPrefix = "conn" }: { onAdded: (c: Connection) => void; onCancel?: () => void; idPrefix?: string }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const urlOk = /^https?:\/\/\S+$/.test(url.trim());
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="text-sm font-medium text-ink">Add a service that speaks Jev's API</p>
      <p className="text-sm text-slate">It takes a /v1/systemone request and returns the same answers. Every route on this account can use it.</p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-4 sm:grid-cols-2">
        <Field label="Name" id={`${idPrefix}-name`}>
          <TextInput id={`${idPrefix}-name`} data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Our GPU box" maxLength={40} />
        </Field>
        <Field label="URL" id={`${idPrefix}-url`} error={url && !urlOk ? "Use a full URL, starting with http:// or https://." : undefined}>
          <TextInput id={`${idPrefix}-url`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://models.example.com/v1/systemone" />
        </Field>
      </div>
      <Field label="Key" id={`${idPrefix}-key`} hint="Optional. Sent as Authorization: Bearer … to that service. Stored encrypted and never shown again.">
        <TextInput id={`${idPrefix}-key`} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      {err && <p className="mt-2 text-sm text-stop">{err}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={!name.trim() || !urlOk}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const c = await addConnection({ kind: "systemone", name: name.trim(), url: url.trim(), ...(key ? { key } : {}) });
              setKey("");
              onAdded(c);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Add {name.trim() || "this service"}
        </Button>
        {onCancel && (
          <Button size="sm" variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export function JevConnection({ c, onSaved }: { c: Connection; onSaved: (c: Connection) => void }) {
  const [owner, setOwner] = useState<"ours" | "yours">(c.key_owner);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => setOwner(c.key_owner), [c.key_owner]);
  const needsKey = owner === "yours" && !(c.key_owner === "yours" && c.has_key) && !key;
  const changed = owner !== c.key_owner || !!key;
  return (
    <div>
      <p className="flex flex-wrap items-baseline gap-x-2 text-base">
        <b className="font-medium text-ink">{c.name}</b>
        <code className="break-all font-mono text-xs text-slate">{c.url}</code>
      </p>
      <fieldset className="mt-2">
        <legend className="sr-only">Whose key reaches {c.name}</legend>
        <Radio
          name="jev-owner"
          value="ours"
          checked={owner === "ours"}
          onChange={() => setOwner("ours")}
          title={billingOn() ? "Dopp's key (billed through your credits)" : "This server's key"}
          body={billingOn() ? "No TypeSafe account needed. Each answer shows up on Usage." : "The TypeSafe key set on this server (TYPESAFE_API_KEY). Each answer's cost shows up on Usage."}
        />
        <Radio
          name="jev-owner"
          value="yours"
          checked={owner === "yours"}
          onChange={() => setOwner("yours")}
          title="Your TypeSafe key"
          body="TypeSafe bills you directly. Stored encrypted; never shown again."
        />
      </fieldset>
      {owner === "yours" && (
        <Field label="TypeSafe key" id="jev-key" hint={c.key_owner === "yours" && c.has_key ? "Saved key •••• kept. Paste a new one only to replace it." : undefined}>
          <TextInput id="jev-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={c.key_owner === "yours" && c.has_key ? "saved key •••• keep" : "sk-…"} />
        </Field>
      )}
      {err && <p className="mt-2 text-sm text-stop">{err}</p>}
      {changed && <div className="mt-3">
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={needsKey}
          title={needsKey ? "Paste your TypeSafe key first" : undefined}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const next = await setJevConnection(key ? { key_owner: owner, key } : { key_owner: owner });
              setKey("");
              onSaved(next);
              toast.show(owner === "ours" ? `${c.name} is reached with ${ourKey(billingOn())}.` : `${c.name} is reached with your key.`);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save how {c.name} is reached
        </Button>
        {needsKey && <span className="ml-2 text-sm text-slate">Paste your key first.</span>}
      </div>}
    </div>
  );
}

export function ServiceRow({ c, onRemoved, extra }: { c: Connection; onRemoved: () => void; extra?: React.ReactNode }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <li className="border-t border-line py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <b className="font-medium text-ink">{c.name}</b>
        <code className="min-w-0 break-all font-mono text-xs text-slate">{c.url}</code>
        <span className="text-xs text-slate">{c.has_key ? "key saved" : "no key"}</span>
        <span className="ml-auto flex items-center gap-2">
          {sure ? (
            <>
              <span className="text-sm text-slate">Remove {c.name}?</span>
              <Button
                size="sm"
                variant="danger"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    await deleteConnection(c.id);
                    onRemoved();
                  } catch (e) {
                    setErr((e as Error).message);
                    setSure(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setSure(false)}>
                Keep
              </Button>
            </>
          ) : (
            <QuietLink tone="danger" onClick={() => setSure(true)}>
              Remove
            </QuietLink>
          )}
        </span>
      </div>
      {extra}
      {err && <p className="mt-1 text-sm text-stop">{err}</p>}
    </li>
  );
}

