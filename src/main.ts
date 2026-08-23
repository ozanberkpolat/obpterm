import { pickTransport, withDefaults } from "./transport";
import { App } from "./app";
import { installKeys } from "./keys";
import { installFind } from "./find";
import { Status } from "./status";
import { installToolbar } from "./toolbar";
import { installHeader } from "./header";
import { installPalette } from "./palette";
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
  app.palette = installPalette(app);
  installHeader(app);
  tp.onConfigChanged(() => void app.reloadConfig());
  app.applyRailWidth();
  app.applyConfig();
  installKeys(app);
  (window as unknown as { obpterm: App }).obpterm = app; // devtools handle
  installCrashGuard(app);
  const { restored, crashed, updatedTo } = await app.restoreSession();
  const tabs = `${restored} tab${restored > 1 ? "s" : ""}`;
  if (!restored) await app.newTab();
  if (updatedTo) toast(`Updated to ${updatedTo} — reopened ${tabs}`);
  else if (crashed) toast(`Reopened ${tabs} — OBPTerm did not shut down cleanly`);
  if (config.update_check_on_launch && !updatedTo) {
    // Quietly, and never installing on its own.
    window.setTimeout(() => void app.status.checkUpdates(), 4000);
  }
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
