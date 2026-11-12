// Landing "Plain-Language Reference": one capability card at a time, moved with
// left/right arrow buttons (plus a dot per card). Each card is a self-contained
// slide, so this module only decides which one is visible and keeps the arrows,
// the dots and the live status in sync.

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

/** Wires every capability carousel under `root`. Safe to call once on load. */
export function initSupportCarousel(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-carousel]').forEach((carousel) => {
    const slides = Array.from(carousel.querySelectorAll<HTMLElement>('[data-slide]'));
    if (slides.length === 0) return;

    const dots = Array.from(carousel.querySelectorAll<HTMLButtonElement>('[data-dot]'));
    const prev = carousel.querySelector<HTMLButtonElement>('[data-carousel-prev]');
    const next = carousel.querySelector<HTMLButtonElement>('[data-carousel-next]');
    const status = carousel.querySelector<HTMLElement>('[data-carousel-status]');
    let current = 0;

    const select = (index: number): void => {
      current = ((index % slides.length) + slides.length) % slides.length;
      slides.forEach((slide, i) => {
        const on = i === current;
        slide.hidden = !on;
        slide.classList.toggle('is-active', on);
      });
      dots.forEach((dot, i) => {
        const on = i === current;
        dot.classList.toggle('is-active', on);
        if (on) dot.setAttribute('aria-current', 'true');
        else dot.removeAttribute('aria-current');
      });
      if (status) {
        const title = slides[current]?.dataset.title ?? '';
        status.textContent = `${title} — ${current + 1} of ${slides.length}`;
      }
    };

    prev?.addEventListener('click', () => select(current - 1));
    next?.addEventListener('click', () => select(current + 1));
    dots.forEach((dot, i) => dot.addEventListener('click', () => select(i)));

    carousel.addEventListener('keydown', (event) => {
      const target = carouselStep(event.key, current, slides.length);
      if (target === null) return;
      event.preventDefault();
      select(target);
    });

    select(current);
  });
}
