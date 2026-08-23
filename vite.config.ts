import { defineConfig } from "vite";

// host: true so another machine on the same network can open the dev UI while
// `npm run devserver` provides real shells on :1421. Inside the Tauri app this file is only
// used for the production build.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    minify: true,
    sourcemap: false,
    // Two entries: the terminal window and the settings window.
    rollupOptions: { input: { main: "index.html", settings: "settings.html" } },
  },
});
