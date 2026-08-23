// Toast with an optional undo — the app never uses confirm() (see iot-stack CRAFT.md).
let timer = 0;

export function toast(message: string, undo?: { label: string; run: () => void }) {
  const el = document.querySelector<HTMLElement>("#toast")!;
  el.replaceChildren(document.createTextNode(message));
  el.classList.toggle("error", !undo && /error|could not|not saved/i.test(message));
  if (undo) {
    const b = document.createElement("button");
    b.className = "undo";
    b.textContent = undo.label;
    b.onclick = () => {
      undo.run();
      el.hidden = true;
    };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(timer);
  timer = window.setTimeout(() => (el.hidden = true), undo ? 8000 : 5000);
}

/** Turns a rail label into an inline text field. Enter commits, Escape/blur cancels. */
export function editInline(host: HTMLElement, value: string, placeholder: string, commit: (v: string) => void) {
  const input = document.createElement("input");
  input.className = "inline-edit";
  input.value = value;
  input.placeholder = placeholder;
  host.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v) commit(v);
    else commit(value); // caller re-renders either way
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}
