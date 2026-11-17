// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@/` is src/; tsconfig.json and the web test project say the same.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    // Both have defaults everything else assumes; the first-run check moves them beside a running app.
    port: Number(process.env.DIREX_WEB_PORT ?? 5173),
    proxy: { "/api": `http://127.0.0.1:${process.env.PORT ?? 3000}` },
  },
});
