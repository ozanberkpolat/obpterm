import { pickTransport } from "./transport";
import { App, toast } from "./app";
import { installKeys } from "./keys";

async function main() {
  const tp = await pickTransport();
  const config = await tp.loadConfig().catch(async (e) => {
    // Fail loud: a corrupt config.json is shown, not silently replaced.
    throw new Error(`${e}\n(${await tp.configPath().catch(() => "config path unknown")})`);
  });
  const app = new App(tp, config);
  app.applyConfig();
  installKeys(app);
  (window as unknown as { winterm: App }).winterm = app; // devtools handle
  await app.newTab();
}

main().catch((e) => {
  console.error(e);
  toast(String(e));
  document.querySelector("#panes")!.textContent = String(e);
});
