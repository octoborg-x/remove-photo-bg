// Landing-page ambient layers:
//   • a parallel OffscreenCanvas background driven by a dedicated worker, and
//   • a multi-directional scroll-assembly controller for semantic blocks.
// Both are progressive: without IntersectionObserver / OffscreenCanvas, or with
// reduced motion requested, the page stays static and fully visible.

const BG_WORKER_URL = '/bg-parallel-worker.js';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

/** A cheap main-thread fallback: one soft gradient, no animation loop. */
function paintStaticBackground(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const glow = ctx.createRadialGradient(
    width * 0.5,
    height * 0.35,
    20,
    width * 0.5,
    height * 0.35,
    Math.max(width, height) * 0.65,
  );
  glow.addColorStop(0, 'rgba(138, 180, 248, 0.08)');
  glow.addColorStop(0.5, 'rgba(197, 138, 249, 0.04)');
  glow.addColorStop(1, 'rgba(19, 19, 20, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
}

/**
 * Starts the background layer. Returns a cleanup function; call it when the
 * landing page is torn down (tests, hot reload).
 */
export function initParallelBackground(): () => void {
  const canvas = document.getElementById('parallel-bg-canvas') as HTMLCanvasElement | null;
  if (!canvas) return () => {};

  const reduced = prefersReducedMotion();
  if (typeof canvas.transferControlToOffscreen !== 'function') {
    paintStaticBackground(canvas);
    return () => {};
  }

  let worker: Worker;
  try {
    worker = new Worker(BG_WORKER_URL, { type: 'classic' });
  } catch {
    paintStaticBackground(canvas);
    return () => {};
  }

  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage(
    {
      type: 'init',
      canvas: offscreen,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
      dpr: window.devicePixelRatio || 1,
      reducedMotion: reduced,
    },
    [offscreen],
  );

  let lastScrollY = window.scrollY;
  let scrollTick = false;
  let pointerTick = false;
  let latestPointer = { x: -9999, y: -9999 };

  const sendScroll = (): void => {
    scrollTick = false;
    const currentY = window.scrollY;
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    worker.postMessage({
      type: 'scroll',
      progress: Math.min(1, Math.max(0, currentY / maxScroll)),
      velocity: currentY - lastScrollY,
    });
    lastScrollY = currentY;
  };

  const onScroll = (): void => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(sendScroll);
  };

  const onResize = (): void => {
    worker.postMessage({
      type: 'resize',
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
      dpr: window.devicePixelRatio || 1,
    });
  };

  const onPointerMove = (event: PointerEvent): void => {
    latestPointer = { x: event.clientX, y: event.clientY };
    if (pointerTick) return;
    pointerTick = true;
    requestAnimationFrame(() => {
      pointerTick = false;
      worker.postMessage({ type: 'pointer', ...latestPointer });
    });
  };

  // The studio overlay is opaque, so the background can idle while it is open.
  const pauseObserver = new MutationObserver(() => {
    worker.postMessage({
      type: 'pause',
      paused: document.body.classList.contains('studio-open'),
    });
  });
  pauseObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  return () => {
    pauseObserver.disconnect();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('pointermove', onPointerMove);
    worker.terminate();
  };
}

/**
 * Adds `.is-assembled` to `[data-assemble]` blocks as they enter the viewport,
 * so each semantic element glides in from its own direction and locks into
 * place. Elements below the fold reset when scrolled away, so the assembly
 * replays on the way back down.
 */
export function initScrollAssembly(): () => void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-assemble]'));
  if (targets.length === 0) return () => {};

  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
    targets.forEach((element) => element.classList.add('is-assembled'));
    return () => {};
  }

  document.documentElement.classList.add('assemble-ready');

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (entry.isIntersecting) {
          element.classList.add('is-assembled');
        } else if (entry.boundingClientRect.top > window.innerHeight * 0.9) {
          element.classList.remove('is-assembled');
        }
      }
    },
    { threshold: 0.14, rootMargin: '0px 0px -6% 0px' },
  );

  targets.forEach((element) => observer.observe(element));

  return () => {
    observer.disconnect();
    document.documentElement.classList.remove('assemble-ready');
  };
}
