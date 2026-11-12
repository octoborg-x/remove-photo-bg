// Landing showcase: one before/after example at a time, chosen from a vertical
// rail of thumbnails.
//
// Each example is a self-contained `[data-compare]` figure (its own images,
// range and caption), so the existing compare-slider wiring is untouched — this
// module only decides which panel is visible and keeps the rail's tab state in
// sync. The rail is a vertical tablist: arrow keys move the selection (wrapping),
// Home/End jump to the ends, and the roving tabindex keeps a single tab stop.

/** The next selected index for a vertical tablist key, or `null` when unhandled. */
export function galleryStep(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowUp':
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Wires every showcase gallery under `root`. Safe to call once on load. */
export function initShowcaseGallery(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-showcase]').forEach((gallery) => {
    const tabs = Array.from(gallery.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    if (tabs.length === 0) return;

    const panels = tabs.map((tab) =>
      gallery.querySelector<HTMLElement>(`#${CSS.escape(tab.getAttribute('aria-controls') ?? '')}`),
    );

    const select = (index: number, focus = false): void => {
      tabs.forEach((tab, i) => {
        const on = i === index;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        tab.classList.toggle('is-active', on);
        const panel = panels[i];
        if (panel) panel.hidden = !on;
      });
      if (focus) tabs[index]?.focus();
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(i));
      tab.addEventListener('keydown', (event) => {
        const next = galleryStep(event.key, i, tabs.length);
        if (next === null) return;
        event.preventDefault();
        select(next, true);
      });
    });

    const initial = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    select(initial < 0 ? 0 : initial);
  });
}
