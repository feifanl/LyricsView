// The font list offered in Settings → Overlay.
//
// Nothing is bundled. These are faces Windows ships (or that arrive with Office),
// so there is no font file to redistribute, no licence to honour and no weight
// added to the installer. The trade is that any given machine may not have all of
// them, so the list is filtered to what is actually installed before it is shown.
//
// CJK faces are included deliberately: lyrics are frequently Korean, Japanese or
// Chinese, and a Latin-only face renders those as tofu boxes.

export interface FontGroup {
  label: string;
  fonts: string[];
}

export const FONT_GROUPS: FontGroup[] = [
  {
    label: "Sans",
    fonts: [
      "Segoe UI",
      "Segoe UI Variable",
      "Bahnschrift",
      "Arial",
      "Calibri",
      "Candara",
      "Corbel",
      "Franklin Gothic Medium",
      "Lucida Sans",
      "Tahoma",
      "Trebuchet MS",
      "Verdana",
    ],
  },
  {
    label: "Serif",
    fonts: [
      "Cambria",
      "Constantia",
      "Georgia",
      "Palatino Linotype",
      "Sitka Text",
      "Times New Roman",
      "Book Antiqua",
      "Garamond",
    ],
  },
  {
    label: "Display & script",
    fonts: [
      "Segoe Script",
      "Segoe Print",
      "Gabriola",
      "Ink Free",
      "Impact",
      "Comic Sans MS",
      "Papyrus",
    ],
  },
  {
    label: "Monospace",
    fonts: ["Cascadia Code", "Cascadia Mono", "Consolas", "Courier New", "Lucida Console"],
  },
  {
    label: "CJK",
    fonts: [
      "Malgun Gothic", // Korean
      "Yu Gothic UI", // Japanese
      "Meiryo", // Japanese
      "Microsoft YaHei UI", // Simplified Chinese
      "Microsoft JhengHei UI", // Traditional Chinese
      "MS Gothic",
      "SimSun",
    ],
  },
];

/** Wide, mixed-width sample — narrow strings can measure identically across
 *  genuinely different faces and produce a false negative. */
const PROBE = "mmmiiiwwwWMI0Oo—@";
const PROBE_PX = 72;

/**
 * Whether `family` is installed, by measuring the probe against the generic
 * fallbacks. If the width matches every fallback, the browser silently
 * substituted one of them and the face is not present.
 *
 * `document.fonts.check` is unreliable for locally installed families in a
 * webview, so measurement it is.
 */
function makeDetector(): (family: string) => boolean {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => true; // can't measure; offer everything rather than nothing

  const generics = ["monospace", "serif", "sans-serif"];
  const baseline = new Map<string, number>();
  for (const g of generics) {
    ctx.font = `${PROBE_PX}px ${g}`;
    baseline.set(g, ctx.measureText(PROBE).width);
  }

  return (family: string): boolean => {
    for (const g of generics) {
      ctx.font = `${PROBE_PX}px "${family}", ${g}`;
      if (ctx.measureText(PROBE).width !== baseline.get(g)) return true;
    }
    return false;
  };
}

/** The groups, filtered to installed faces, with empty groups dropped. */
export function availableFontGroups(): FontGroup[] {
  const has = makeDetector();
  return FONT_GROUPS.map((g) => ({ label: g.label, fonts: g.fonts.filter(has) })).filter(
    (g) => g.fonts.length > 0,
  );
}
