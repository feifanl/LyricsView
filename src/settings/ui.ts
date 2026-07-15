// Small DOM helpers for building settings controls without a framework.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

export function field(label: string, control: Node, hint?: string): HTMLElement {
  const row = el("div", { className: "field" }, [el("label", { textContent: label }), control]);
  if (hint) row.append(el("span", { className: "hint", textContent: hint }));
  return row;
}

export function section(title: string): HTMLElement {
  return el("h2", { textContent: title });
}

export function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = el("input", { type: "text", value });
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

export function numberInput(
  value: number,
  onChange: (v: number) => void,
  opts: { min?: number; max?: number; step?: number } = {},
): HTMLInputElement {
  const input = el("input", { type: "number", value: String(value) });
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  if (opts.step !== undefined) input.step = String(opts.step);
  input.addEventListener("input", () => {
    const n = Number(input.value);
    if (!Number.isNaN(n)) onChange(n);
  });
  return input;
}

/** Extract the #rrggbb part of a color for the native picker (alpha stripped). */
function hex6(value: string): string {
  return /^#[0-9a-fA-F]{6,8}$/.test(value) ? value.slice(0, 7) : "#ffffff";
}
/** The trailing alpha (#..aa) of a hex8 color, or "" when none. */
function alphaSuffix(value: string): string {
  return /^#[0-9a-fA-F]{8}$/.test(value) ? value.slice(7) : "";
}

/** Color field: a native swatch picker plus a hex box that keeps #rrggbbaa. */
export function colorInput(value: string, onChange: (v: string) => void): HTMLElement {
  const picker = el("input", { type: "color", className: "color-picker", value: hex6(value) });
  const text = el("input", { type: "text", className: "color-hex", value });

  picker.addEventListener("input", () => {
    const next = picker.value + alphaSuffix(text.value);
    text.value = next;
    onChange(next);
  });
  text.addEventListener("input", () => {
    picker.value = hex6(text.value);
    onChange(text.value);
  });
  return el("span", { className: "color-field" }, [picker, text]);
}

export function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

export function select<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLSelectElement {
  const sel = el("select");
  for (const o of options) {
    const opt = el("option", { value: o.value, textContent: o.label });
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value as T));
  return sel;
}

export function range(
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
): HTMLInputElement {
  const input = el("input", { type: "range", value: String(value) });
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.addEventListener("input", () => onChange(Number(input.value)));
  return input;
}

export function button(
  label: string,
  onClick: () => void,
  cls = "ghost",
): HTMLButtonElement {
  const b = el("button", { className: cls, textContent: label });
  b.addEventListener("click", onClick);
  return b;
}

/** A titled panel that groups related controls. */
export function card(title: string, children: (Node | string)[], opts: { wide?: boolean } = {}): HTMLElement {
  const head = el("div", { className: "card-head" }, [el("span", { className: "card-title", textContent: title })]);
  const body = el("div", { className: "card-body" }, children);
  return el("div", { className: "card" + (opts.wide ? " card--wide" : "") }, [head, body]);
}

/** Segmented control — a compact set of mutually exclusive buttons. */
export function segmented<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = el("div", { className: "seg" });
  wrap.setAttribute("role", "radiogroup");
  const btns: HTMLButtonElement[] = [];
  for (const o of options) {
    const b = el("button", { className: "seg-btn" + (o.value === value ? " active" : ""), textContent: o.label });
    b.addEventListener("click", () => {
      for (const x of btns) x.classList.remove("active");
      b.classList.add("active");
      onChange(o.value);
    });
    btns.push(b);
    wrap.append(b);
  }
  return wrap;
}
