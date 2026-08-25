import { pickTransport, withDefaults } from "./transport";
import { App } from "./app";
import { installKeys } from "./keys";
import { bindKeys } from "./keymap";
import { installFind } from "./find";
import { Status } from "./status";
import { installToolbar } from "./toolbar";
import { installHeader } from "./header";
import { installPalette } from "./palette";
import { installSettings } from "./settings-panel";
import { Deck } from "./deck";
import { installAgentEvents } from "./agent";
import "./settings.css";
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
  app.settings = installSettings(app);
  app.deck = new Deck(app);
  installHeader(app);
  app.applyRailWidth();
  app.applyConfig();
  bindKeys(config);
  installKeys(app);
  (window as unknown as { obpterm: App }).obpterm = app; // devtools handle
  installCrashGuard(app);
  await app.connectHost();
  // Running decays to idle on its own, so the rail re-derives once a second. The rail patches
  // rows in place, so this is a handful of attribute writes, not a rebuild.
  window.setInterval(() => app.onPaneActivity(), 1000);
  window.setInterval(() => void app.sleepIdleTabs(), 30_000);
  window.setInterval(() => app.ecoSweep(), 60_000);
  window.setInterval(() => void app.refreshAgentTitles(), 5_000);
  installAgentEvents(app);
  // Hooks go in automatically (the user chose that): the default login's dir plus every
  // account's. A marked block; Settings can remove it.
  const hookDirs = [...new Set(["~/.claude", ...config.accounts.map((a) => a.claude_dir).filter((d): d is string => !!d)])];
  void tp
    .hooksEnsure(hookDirs)
    .then((changed) => {
      if (changed.length) toast(`Claude Code hooks + status line installed (${changed.length} settings file${changed.length > 1 ? "s" : ""}) — agent states and token meters are live`);
      // The statusLine now writes ~/.claude/limits.json; point the meters there unless the
      // user already chose a source.
      if (!config.limits_file && !config.limits_url) {
        config.limits_file = "~/.claude/limits.json";
        app.persistConfig();
      }
    })
    .catch(() => {});
  window.setInterval(() => void app.refreshHeld(), 3_000);
  window.addEventListener("focus", () => app.clearAttention());
  const { restored, crashed, updatedTo } = await app.restoreSession();
  const tabs = `${restored} tab${restored > 1 ? "s" : ""}`;
  if (!restored) await app.newTab();
  const kept = app.reattached ? ` — ${app.reattached} shell${app.reattached > 1 ? "s" : ""} never stopped` : "";
  if (updatedTo) toast(`Updated to ${updatedTo}${kept || ` — reopened ${tabs}`}`);
  else if (crashed) toast(`Reopened ${tabs} — OBPTerm did not shut down cleanly`);
  else if (app.reattached) toast(`Back${kept}`);
  if (!app.hostInstance) toast("No session host: shells will end when the window closes");
  // Retention runs once, a moment after launch, so a folder that grew overnight is dealt with
  // before it matters. Silent unless it actually removed something.
  if (config.capture_keep_days || config.capture_max_mb) {
    window.setTimeout(async () => {
      const dir = config.capture_dir || (await tp.logDir().catch(() => ""));
      if (!dir) return;
      const [gone, freed] = await tp
        .pruneCaptures(dir, config.capture_keep_days, config.capture_max_mb)
        .catch(() => [0, 0] as [number, number]);
      if (gone) console.info(`obpterm: pruned ${gone} capture files, ${freed} bytes`);
    }, 6000);
  }
  if (config.update_check_on_launch) {
    // Quietly, never installing on its own — and again once a day, because the window now
    // stays open for weeks (that is what the session host is for).
    if (!updatedTo) window.setTimeout(() => void app.status.checkUpdates(true), 4000);
    window.setInterval(() => void app.status.checkUpdates(true), 24 * 3_600_000);
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
