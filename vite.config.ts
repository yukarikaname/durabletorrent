import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// `cf dev` / `cf build` hand the build to this Vite config because the
// Cloudflare Vite plugin is installed. See cloudflare.config.ts for bindings.
export default defineConfig({
  plugins: [cloudflare()],
});
