import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { Config } from "./transport";

export interface Term {
  term: Terminal;
  search: SearchAddon;
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
  const search = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.loadAddon(new WebLinksAddon());
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
    search,
    // A hidden tab measures 0 wide; fitting then would resize the shell to nothing.
    fit: () => container.clientWidth > 0 && container.clientHeight > 0 && fitAddon.fit(),
    dispose: () => term.dispose(),
  };
}

export function applyTermConfig(term: Terminal, config: Config) {
  term.options.fontFamily = config.font_family;
  term.options.fontSize = config.font_size;
  term.options.scrollback = config.scrollback;
  term.options.theme = config.theme as ITheme;
}
