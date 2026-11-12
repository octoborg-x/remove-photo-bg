// Landing "Plain-Language Reference": one capability card at a time, paged with
// left/right arrows, dots, the keyboard or a swipe.
//
// The slides all live in the DOM inside a single flex track; only the active one
// is on screen and the track slides between them, so the surrounding section
// never grows to the height of six cards at once. A slide that is off screen is
// `inert` and `aria-hidden`, which keeps its links and text out of the tab order
// and the accessibility tree until it is the one being shown.

/** The next selected index for a carousel key, or `null` when unhandled. */
export function carouselStep(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Wraps `index` into `[0, count)`; `count <= 0` yields 0. */
export function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

/** Wires every support carousel under `root`. Safe to call once on load. */
export function initSupportCarousel(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-support-carousel]').forEach((carousel) => {
    const track = carousel.querySelector<HTMLElement>('[data-support-track]');
    const slides = Array.from(carousel.querySelectorAll<HTMLElement>('[data-support-slide]'));
    if (!track || slides.length === 0) return;

    const viewport = carousel.querySelector<HTMLElement>('[data-support-viewport]') ?? carousel;
    const prev = carousel.querySelector<HTMLButtonElement>('[data-support-prev]');
    const next = carousel.querySelector<HTMLButtonElement>('[data-support-next]');
    const dots = Array.from(carousel.querySelectorAll<HTMLButtonElement>('[data-support-dot]'));

    let index = 0;

    const render = (): void => {
      track.style.transform = `translateX(-${index * 100}%)`;
      slides.forEach((slide, i) => {
        const on = i === index;
        slide.classList.toggle('is-active', on);
        slide.setAttribute('aria-hidden', String(!on));
        // `inert` keeps a hidden slide's content out of the tab order.
        slide.toggleAttribute('inert', !on);
      });
      dots.forEach((dot, i) => {
        const on = i === index;
        dot.classList.toggle('is-active', on);
        dot.setAttribute('aria-selected', String(on));
        dot.tabIndex = on ? 0 : -1;
      });
    };

    const go = (to: number): void => {
      const target = wrapIndex(to, slides.length);
      if (target === index) return;
      index = target;
      render();
    };

    prev?.addEventListener('click', () => go(index - 1));
    next?.addEventListener('click', () => go(index + 1));
    dots.forEach((dot, i) => dot.addEventListener('click', () => go(i)));

    carousel.addEventListener('keydown', (event) => {
      const step = carouselStep(event.key, index, slides.length);
      if (step === null) return;
      event.preventDefault();
      go(step);
    });

    let startX = 0;
    let startY = 0;
    let tracking = false;
    viewport.addEventListener(
      'touchstart',
      (event) => {
        if (event.touches.length !== 1) return;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        tracking = true;
      },
      { passive: true },
    );
    viewport.addEventListener('touchend', (event) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      // A mostly-horizontal flick pages the carousel; a vertical drag is a
      // page scroll and must be left alone.
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? index + 1 : index - 1);
    });

    render();
  });
}
