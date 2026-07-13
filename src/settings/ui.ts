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

/** Color text field (supports #rrggbbaa) with a live swatch. */
export function colorInput(value: string, onChange: (v: string) => void): HTMLElement {
  const swatch = el("span", { className: "swatch" });
  swatch.style.background = value;
  const input = el("input", { type: "text", value });
  input.style.minWidth = "120px";
  input.addEventListener("input", () => {
    swatch.style.background = input.value;
    onChange(input.value);
  });
  return el("span", { className: "color-field" }, [swatch, input]);
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
