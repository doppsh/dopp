import { useState } from "react";
import type { ReactNode } from "react";
import { DEF } from "../lib/domain";
import { Button } from "./Button";

/* ---------- option chips: single-select ---------- */

export interface ChipOption {
  value: string;
  label: string;
  title?: string;
}

export function Chips({
  options,
  value,
  onSelect,
  disabled,
  ariaLabel,
}: {
  options: ChipOption[];
  value: string | null;
  onSelect: (v: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            disabled={disabled}
            onClick={() => onSelect(o.value)}
            className={`rounded-full border px-2.5 py-0.5 text-sm transition-colors disabled:opacity-45 ${
              on
                ? "border-ink bg-ink text-paper"
                : "border-line bg-surface text-ink hover:border-slate hover:bg-panel"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only option pills, e.g. the options a question offers. */
export function OptionList({ options }: { options: string[] }) {
  if (!options.length) return <span className="text-sm text-slate">no options</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <span key={o} className="rounded-full bg-panel px-2 py-px text-xs text-slate">
          {o}
        </span>
      ))}
    </div>
  );
}

/* ---------- copy ---------- */

export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
}: {
  text: string;
  label?: string;
  size?: "sm" | "md";
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

export function CodeBlock({
  code,
  label,
  wrap,
  maxHeight = 320,
}: {
  code: string;
  label?: ReactNode;
  wrap?: boolean;
  maxHeight?: number;
}) {
  return (
    <div className="min-w-0">
      {label && <p className="mb-1.5 text-xs text-slate">{label}</p>}
      <div className="relative min-w-0 rounded border border-line bg-panel">
        <pre
          className={`m-0 overflow-auto p-3 pr-16 font-mono text-xs leading-relaxed ${
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
          }`}
          style={{ maxHeight }}
        >
          {code}
        </pre>
        <div className="absolute right-2 top-2">
          <CopyButton text={code} />
        </div>
      </div>
    </div>
  );
}

/* ---------- states ---------- */

export function EmptyState({
  title,
  body,
  action,
}: {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line px-5 py-8 text-center">
      <p className="text-base font-medium text-ink">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-[52ch] text-sm text-slate">{body}</p>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Couldn't load this.",
  detail,
  onRetry,
}: {
  title?: ReactNode;
  detail?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stop/40 bg-stop-soft px-4 py-3"
    >
      <div className="min-w-0">
        <p className="text-base font-medium text-stop">{title}</p>
        {detail && <p className="mt-0.5 text-sm text-ink/80">{detail}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ w = "100%", h = 12, className = "" }: { w?: string; h?: number; className?: string }) {
  return <span className={`skel ${className}`} style={{ width: w, height: h }} />;
}

/* ---------- vocabulary tooltip ---------- */

export function Term({ t, children }: { t: string; children?: ReactNode }) {
  return (
    <abbr
      title={DEF[t] || ""}
      className="cursor-help no-underline [text-decoration:underline_dotted] [text-underline-offset:3px] decoration-slate"
    >
      {children ?? t}
    </abbr>
  );
}

/* ---------- forms ---------- */

const inputCls =
  "w-full rounded border border-line bg-surface px-2.5 py-1.5 text-base text-ink placeholder:text-slate focus-visible:border-accent";

export function Field({
  label,
  hint,
  error,
  children,
  id,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block text-base font-medium text-ink">
        {label}
      </label>
      {hint && <p className="mb-1 mt-0.5 text-sm text-slate">{hint}</p>}
      <div className="mt-1">{children}</div>
      {error && <p className="mt-1 text-sm text-stop">{error}</p>}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className || ""}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`${inputCls} resize-y font-mono text-sm leading-relaxed ${props.className || ""}`}
    />
  );
}

export function Radio({
  name,
  value,
  checked,
  onChange,
  title,
  body,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (v: string) => void;
  title: ReactNode;
  body: ReactNode;
}) {
  return (
    <label className="grid cursor-pointer grid-cols-[auto_1fr] items-start gap-3 border-t border-line py-3">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-1.5 h-4 w-4 accent-[var(--accent)]"
      />
      <span>
        <b className="text-base font-medium text-ink">{title}</b>
        <span className="mt-0.5 block text-sm text-slate">{body}</span>
      </span>
    </label>
  );
}
