import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import type { Config } from "./transport";

export interface Term {
  term: Terminal;
  fit(): void;
  dispose(): void;
}

const isWindows = navigator.userAgent.includes("Windows");

export function createTerm(container: HTMLElement, config: Config): Term {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: config.font_family,
    fontSize: config.font_size,
    scrollback: config.scrollback,
    theme: config.theme as ITheme,
    // ConPTY reflows on its own; telling xterm keeps its reflow from fighting it.
    windowsPty: isWindows ? { backend: "conpty" } : undefined,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(container);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose()); // falls back to the DOM renderer
    term.loadAddon(webgl);
  } catch (e) {
    console.warn("webgl renderer unavailable, using DOM renderer", e);
  }
  return {
    term,
    fit: () => fitAddon.fit(),
    dispose: () => term.dispose(),
  };
}

export function applyTermConfig(term: Terminal, config: Config) {
  term.options.fontFamily = config.font_family;
  term.options.fontSize = config.font_size;
  term.options.scrollback = config.scrollback;
  term.options.theme = config.theme as ITheme;
}
