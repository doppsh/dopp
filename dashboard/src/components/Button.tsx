import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex max-w-full items-center justify-center gap-2 rounded border text-center font-medium leading-tight transition-colors disabled:opacity-45 disabled:cursor-not-allowed";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-paper border-ink hover:opacity-90",
  secondary: "bg-surface text-ink border-line hover:bg-panel",
  quiet: "bg-transparent text-slate border-transparent hover:bg-panel hover:text-ink",
  danger: "bg-transparent text-stop border-line hover:bg-stop-soft",
};

const sizes: Record<ButtonSize, string> = {
  sm: "min-h-7 px-2.5 py-1 text-sm",
  md: "min-h-9 px-3.5 py-1.5 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, className = "", disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading ? "Working…" : children}
    </button>
  );
});

/** Same look, but a real link. */
export function LinkButton({
  to,
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const cls = `${base} ${variants[variant]} ${sizes[size]} ${className}`;
  if (/^(https?:|\/)[^/]/.test(to) && (to.startsWith("http") || to.endsWith(".md"))) {
    return (
      <a href={to} className={cls} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} className={cls} {...rest}>
      {children}
    </Link>
  );
}

/** A button that looks like an inline link. For low-weight row actions. */
export function QuietLink({
  className = "",
  tone = "slate",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "slate" | "danger" | "accent" }) {
  const tones = {
    slate: "text-slate hover:text-ink",
    danger: "text-slate hover:text-stop",
    accent: "text-accent hover:underline",
  };
  return (
    <button
      type="button"
      className={`underline underline-offset-2 decoration-line hover:decoration-current text-sm disabled:opacity-45 ${tones[tone]} ${className}`}
      {...rest}
    />
  );
}
