// swipe.js — the menu, by thumb. Wired once by app.js; the sidebar's own
// state (open, closed) stays there, reached through the two functions passed in.

import { $ } from './util.js';
import { navSlide, navSettle } from './ui.js';

/* ---------------- the menu, by thumb ----------------
   Drag in from the left edge to bring the sidebar out, and back to the left to
   put it away. Kept to the edge on purpose: the week grid is a horizontal
   scroller and the tray under it is another, so a swipe that counted anywhere
   on the page would take the gesture away from both. A drag that is mostly
   vertical is a scroll and is let go of at once. */

const EDGE = 26;      // how far in from the left a swipe may start
const SWIPE = 52;     // how far it must travel to count

/* The menu follows the finger. Until the swipe has shown itself to be one
   — sideways, and past a few px — nothing moves, so a scroll down the page
   is still a scroll; after that the sidebar is dragged by the px, with its
   transition off, and the scrim fades in step. On release it settles: past
   halfway, or a flick past SWIPE, and the transition takes it the rest of
   the way. */
/**
 * @param {{ setSidebar: (open: boolean) => void, sidebarOpen: () => boolean, onSettle?: () => void }} deps
 *   onSettle runs after every touch ends, drag or not — app.js redraws there
 *   what it held back while the finger was down.
 */
export function wireNavSwipe({ setSidebar, sidebarOpen, onSettle }) {
  const phone = () => matchMedia('(max-width: 860px)').matches;
  const side = $('#sidebar'), scrim = $('#nav-scrim');
  let x0 = 0, y0 = 0, job = null, live = false, w = 0, dx = 0, stale = null;

  const settle = () => {
    clearTimeout(stale);
    if (job && live) {
      side.classList.remove('dragging');
      document.body.classList.remove('nav-dragging');
      side.style.transform = '';
      scrim.style.opacity = '';
      setSidebar(navSettle(job, dx, w, SWIPE));
    }
    job = null; live = false;
    onSettle?.();
  };
  // the end of a touch can go missing (see navigate), so a menu left
  // mid-way settles on the next touch, or on its own after a moment
  const arm = () => { clearTimeout(stale); stale = setTimeout(settle, 2500); };

  document.addEventListener('touchstart', (e) => {
    if (live) settle();
    job = null; live = false; dx = 0;
    if (!phone() || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (sidebarOpen()) job = 'close';
    else if (t.clientX <= EDGE) job = 'open';
    else return;
    x0 = t.clientX; y0 = t.clientY;
    w = side.getBoundingClientRect().width || Math.min(innerWidth * 0.82, 300);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!job || e.touches.length !== 1) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (!live) {
      // scrolling down the menu is not a swipe out of it
      if (Math.abs(dy) > Math.abs(dx)) { job = null; return; }
      if (Math.abs(dx) < 6) return;
      live = true;
      side.classList.add('dragging');
      document.body.classList.add('nav-dragging');
    }
    const { x, t } = navSlide(job, dx, w);
    side.style.transform = `translateX(${x}px)`;
    scrim.style.opacity = String(t);
    arm();
  }, { passive: true });

  document.addEventListener('touchend', settle, { passive: true });
  document.addEventListener('touchcancel', settle, { passive: true });
}
