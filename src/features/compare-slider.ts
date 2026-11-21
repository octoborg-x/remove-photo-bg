// Before/after comparison slider for the landing page.
//
// Each `[data-compare]` figure holds two stacked images (`.compareBefore`,
// `.compareAfter`) and a range input. The range is the single source of truth:
// it is focusable, keyboard-operable (arrow keys, Home/End) and screen-reader
// labelled, so the comparison works without a pointer. Dragging on the image
// updates the same range, so both inputs stay in sync.

/** Clamps a divider position to the valid 0–100 range. NaN falls back to 50. */
export function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 50;
  return Math.max(0, Math.min(100, value));
}

/** Wires every comparison figure under `root`. Safe to call once on load. */
export function initCompareSliders(root: ParentNode = document): void {
  const figures = root.querySelectorAll<HTMLElement>('[data-compare]');
  figures.forEach((figure) => {
    const range = figure.querySelector<HTMLInputElement>('.compareRange');
    if (!range) return;

    const apply = (value: number): void => {
      figure.style.setProperty('--pos', `${clampPercent(value)}%`);
    };

    const initial = Number(figure.dataset.pos);
    const start = Number.isFinite(initial) ? initial : Number(range.value);
    range.value = String(start);
    apply(start);

    range.addEventListener('input', () => apply(Number(range.value)));

    // Pointer drag on the stage moves the same divider. `dragging` carries the
    // gesture as well as pointer capture: dragging an `<img>` starts a native
    // drag-and-drop, which fires `pointercancel` and drops the capture, so
    // capture alone silently stops the drag after the first move.
    const stage = figure.querySelector<HTMLElement>('.compareStage');
    if (!stage) return;
    stage.querySelectorAll('img').forEach((img) => {
      img.draggable = false;
    });
    let dragging = false;
    const stop = (): void => {
      dragging = false;
    };
    const setFromPointer = (clientX: number): void => {
      if (figure.dataset.compareOn === 'false') return;
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0) return;
      const pct = ((clientX - rect.left) / rect.width) * 100;
      range.value = String(Math.round(pct));
      apply(pct);
    };
    stage.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // Capture is an optimisation; `dragging` alone keeps the drag working.
      }
      setFromPointer(e.clientX);
    });
    stage.addEventListener('pointermove', (e) => {
      if (dragging || stage.hasPointerCapture?.(e.pointerId)) setFromPointer(e.clientX);
    });
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });
}
