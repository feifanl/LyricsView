// Render the current line as a shareable image card (fixed 1200×630 layout)
// and send the PNG to the clipboard + save dialog via Rust.
import { cmd } from "../shared/ipc";

export interface CardData {
  title: string;
  artist: string;
  line: string;
  translation?: string;
  baseColor: string;
  fillColor: string;
  bgColor: string;
  fontFamily: string;
}

const W = 1200;
const H = 630;

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (ctx.measureText(trial).width > maxWidth && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

export async function shareCard(data: CardData): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background with a subtle vertical gradient for depth.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, data.bgColor);
  grad.addColorStop(1, "#000000");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const font = data.fontFamily || "Segoe UI";

  // Main line, centered, wrapped to at most 3 lines.
  ctx.textAlign = "center";
  ctx.fillStyle = data.fillColor;
  ctx.font = `bold 68px "${font}", sans-serif`;
  const lines = wrapLines(ctx, data.line, W - 160, 3);
  const lineHeight = 84;
  const blockTop = H / 2 - ((lines.length - 1) * lineHeight) / 2 - 20;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, blockTop + i * lineHeight));

  // Translation under the line.
  if (data.translation) {
    ctx.fillStyle = data.baseColor;
    ctx.font = `italic 34px "${font}", sans-serif`;
    ctx.fillText(data.translation, W / 2, blockTop + lines.length * lineHeight + 6);
  }

  // Title · artist footer.
  ctx.fillStyle = data.baseColor;
  ctx.font = `28px "${font}", sans-serif`;
  ctx.fillText(`${data.title} — ${data.artist}`, W / 2, H - 56);
  ctx.font = `18px "${font}", sans-serif`;
  ctx.globalAlpha = 0.6;
  ctx.fillText("Lyricify-OSS", W / 2, H - 28);
  ctx.globalAlpha = 1;

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await cmd.shareLineImage(Array.from(bytes));
}
