// Settings window shell. Milestone 1: minimal About tab proving the second
// window opens. Full tab set is built in milestone 10.
import { loadSettings } from "../shared/store";

const tabsEl = document.getElementById("tabs") as HTMLElement;
const contentEl = document.getElementById("tab-content") as HTMLElement;

async function boot(): Promise<void> {
  const settings = await loadSettings();
  document.documentElement.dataset.theme = settings.uiTheme;

  const btn = document.createElement("button");
  btn.className = "tab-btn active";
  btn.textContent = "About";
  tabsEl.appendChild(btn);

  contentEl.innerHTML = `
    <h1>Lyricify-OSS</h1>
    <p class="hint">Free floating karaoke lyrics overlay for Windows.</p>
    <div class="notice">Settings UI is built out in later milestones. The
      overlay window is already live and click-through-ready.</div>
  `;
}

void boot();
