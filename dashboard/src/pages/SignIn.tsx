import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button";
import { Field, TextInput } from "../components/Bits";
import { signInWithPassword } from "../lib/api";
import { Logo } from "../components/Logo";

/* One operator, one password: ADMIN_PASSWORD on the server. There is no sign-up. */
export default function SignIn() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithPassword(password);
      location.assign("/app");   // a full load, so everything reads the new session
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="signin-bg flex min-h-screen w-full items-center justify-center px-4 py-16">
      <div className="page-enter w-full max-w-[420px] rounded-2xl border border-line bg-surface/90 p-7 shadow-[0_20px_60px_rgb(0_0_0/0.35)] backdrop-blur sm:p-8">
        <Link to="/" aria-label="Dopp home" className="inline-block">
          <Logo size={20} />
        </Link>
        <div className="mt-8">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">Sign in</h1>
          <p className="mt-1.5 text-base text-slate">The password is ADMIN_PASSWORD, set on this server.</p>
          <form onSubmit={submit} noValidate className="mt-2">
            <Field label="Password" id="password" error={error}>
              <TextInput
                id="password"
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={!password} className="mt-5 w-full !border-go !bg-go !text-[#06200f] font-semibold hover:!brightness-110">
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
