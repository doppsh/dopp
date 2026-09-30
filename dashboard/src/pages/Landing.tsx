import { Navigate } from "react-router-dom";

// Self-hosted: there is no marketing page. "/" goes to your routes (or to sign-in when you aren't signed in).
export default function Landing() {
  return <Navigate to="/routes" replace />;
}
