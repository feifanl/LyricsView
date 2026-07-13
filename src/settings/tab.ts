import type { Settings } from "../shared/settings";

export interface SettingsCtx {
  /** Current settings snapshot (reassigned after each update). */
  settings: Settings;
  /** Mutate + persist + broadcast + re-render (for structural changes). */
  update(mutator: (s: Settings) => void): Promise<void>;
  /** Mutate + persist + broadcast WITHOUT re-render (for live control edits,
   *  so text inputs keep focus while typing). */
  patch(mutator: (s: Settings) => void): Promise<void>;
  /** Re-render the active tab without persisting. */
  rerender(): void;
}

export interface Tab {
  id: string;
  label: string;
  render(ctx: SettingsCtx): HTMLElement;
}
