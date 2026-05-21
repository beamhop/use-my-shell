import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static SPA. The output of `vite build` (dist/) can be hosted on any static
// host — no server-side component.
//
// `base` is the URL path the app is served under. GitHub Pages serves a
// project repo at `/<repo>/`, so the production build needs that prefix.
// Local dev and other hosts serve from root — override with BASE_PATH=/ .
// `import.meta.env.BASE_URL` reflects this, so the runtime config.json fetch
// resolves correctly under any base.
const base = process.env.BASE_PATH ?? "/use-my-shell/";

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: "esnext",
  },
});
