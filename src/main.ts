import { pickTransport, withDefaults } from "./transport";
import { App } from "./app";
import { installKeys } from "./keys";
import { installFind } from "./find";
import { Status } from "./status";
import { installToolbar } from "./toolbar";
import { installSettings } from "./settings";
import { toast } from "./ui";

async function main() {
  const tp = await pickTransport();
  const loaded = await tp.loadConfig().catch(async (e) => {
    // Fail loud: a corrupt config.json is shown, not silently replaced.
    throw new Error(`${e}\n(${await tp.configPath().catch(() => "config path unknown")})`);
  });
  const config = withDefaults(loaded);
  if (!config.profiles.length) throw new Error("config has no profiles");
  // xterm measures the cell box once; the bundled mono face must be in before the first terminal.
  await document.fonts.load(`${config.font_size}px "JetBrains Mono"`).catch(() => {});
  const app = new App(tp, config);
  app.find = installFind(app);
  app.status = new Status(app);
  app.toolbar = installToolbar(app);
  app.settings = installSettings(app);
  app.applyRailWidth();
  app.applyConfig();
  installKeys(app);
  (window as unknown as { obpterm: App }).obpterm = app; // devtools handle
  installCrashGuard(app);
  const { restored, crashed } = await app.restoreSession();
  if (!restored) await app.newTab();
  else if (crashed) toast(`Reopened ${restored} tab${restored > 1 ? "s" : ""} — OBPTerm did not shut down cleanly`);
}

/**
 * The session file is written on every change, but a debounce can still be in flight when the
 * process dies. Flush on anything that precedes a close, and once a minute regardless.
 */
function installCrashGuard(app: App) {
  const flush = () => void app.flushSession();
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);
  window.addEventListener("blur", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  window.setInterval(flush, 60_000);
}

main().catch((e) => {
  console.error(e);
  toast(String(e));
  document.querySelector("#panes")!.textContent = String(e);
});
