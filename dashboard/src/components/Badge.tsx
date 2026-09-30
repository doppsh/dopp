import type { ReactNode } from "react";

export type Tone = "neutral" | "go" | "wait" | "stop" | "accent" | "solid";

const tones: Record<Tone, string> = {
  neutral: "bg-panel text-slate border-line",
  go: "bg-go-soft text-go border-go/30",
  wait: "bg-wait-soft text-wait border-wait/30",
  stop: "bg-stop-soft text-stop border-stop/30",
  accent: "bg-accent-soft text-accent border-accent/30",
  solid: "bg-go text-white border-go",
};

export function Badge({
  tone = "neutral",
  mono,
  children,
  title,
  className = "",
}: {
  tone?: Tone;
  mono?: boolean;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded border px-1.5 py-px text-xs leading-[1.5] ${
        mono ? "font-mono" : ""
      } ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A `<code>`-styled question id or key. */
export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <code className={`font-mono text-sm rounded bg-panel px-1 py-px text-ink ${className}`}>
      {children}
    </code>
  );
}
