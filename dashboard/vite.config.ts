import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` at the repo root serves this build from the Worker (http://localhost:8787). For hot reload while working on the
// dashboard itself, run the Worker and then `npm run dev -w dashboard`: Vite proxies the API to the Worker below.
const API = process.env.DOPP_API || "http://localhost:8787";
const to = { target: API, changeOrigin: true, autoRewrite: true, cookieDomainRewrite: "" };

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": to, "/auth": to, "/v1": to } },
  preview: { proxy: { "/api": to, "/auth": to, "/v1": to } },
});
