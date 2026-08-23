import { pickTransport, withDefaults } from "./transport";
import { App } from "./app";
import { installKeys } from "./keys";
import { installFind } from "./find";
import { Status } from "./status";
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
  app.applyConfig();
  installKeys(app);
  (window as unknown as { winterm: App }).winterm = app; // devtools handle
  if (!(await app.restoreSession())) await app.newTab();
}

main().catch((e) => {
  console.error(e);
  toast(String(e));
  document.querySelector("#panes")!.textContent = String(e);
});
