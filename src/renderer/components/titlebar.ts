import { isMac } from '../platform.js';

// The strip along the top of the window. On macOS it is the title bar (the
// window hides the native one; main.ts keeps the traffic lights in it), so it
// always shows and drags the window. Elsewhere the native frame stays and the
// strip only appears while the Clawd tub sits in it. Its left part lines up
// with the sidebar so the tub starts above the tabs.

/** Right edge of the macOS traffic lights (see trafficLightPosition in main.ts), plus a gap. */
const TRAFFIC_LIGHTS_END = 86;
const TUB_GAP = 10;

export function initTitlebar(): void {
  const side = document.getElementById('titlebar-side');
  const main = document.getElementById('titlebar-main');
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  if (!side || !main || !sidebar) return;
  if (isMac) document.body.classList.add('mac-titlebar');

  const sync = () => {
    const width = sidebar.getBoundingClientRect().width + (handle?.getBoundingClientRect().width ?? 0);
    side.style.width = `${width}px`;
    // A collapsed sidebar is narrower than the traffic lights: keep the tub clear of them.
    main.style.paddingLeft = `${isMac ? Math.max(TUB_GAP, TRAFFIC_LIGHTS_END - width) : TUB_GAP}px`;
  };
  new ResizeObserver(sync).observe(sidebar);
  sync();
}
