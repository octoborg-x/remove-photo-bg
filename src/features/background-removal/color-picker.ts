// A small HSV colour picker shared by the Background and Bulk colour buttons.
// The colour maths is pure and unit-tested; the DOM part is a thin controller
// over the markup in index.html (#colorPickerPopover). One popover is reused for
// every anchor, so the page carries a single set of colour controls.

import { isTransparent, toRgba, type BackgroundChoice } from './background-color';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsv {
  /** Hue in degrees, 0–360. */
  h: number;
  /** Saturation, 0–1. */
  s: number;
  /** Value/brightness, 0–1. */
  v: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Normalise `abc`, `#abc`, `aabbcc` or `#aabbcc` to `#aabbcc`, else null. */
export function normalizeHex(input: string): string | null {
  const value = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) {
    const [r, g, b] = value;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : null;
}

export function hexToRgb(hex: string): Rgb {
  const value = normalizeHex(hex) ?? '#ffffff';
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  const segments: ReadonlyArray<[number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = segments[Math.floor(hue / 60) % 6];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function hexToHsv(hex: string): Hsv {
  return rgbToHsv(hexToRgb(hex));
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

/** The colour an 8-digit hex alpha byte represents, as a 0–100 percentage. */
export function alphaFromByte(byte: number): number {
  return Math.round((clamp(byte, 0, 255) / 255) * 100);
}

/** A 0–100 alpha percentage as the 2-digit hex byte used by `#rrggbbaa`. */
export function alphaToByteHex(alpha: number): string {
  return Math.round((clamp(alpha, 0, 100) / 100) * 255)
    .toString(16)
    .padStart(2, '0');
}

/** Parse `#rrggbb` or `#rrggbbaa`; alpha defaults to 100%. */
export function parseHexAlpha(input: string): { hex: string; alpha: number } | null {
  const value = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{8}$/i.test(value)) {
    return {
      hex: `#${value.slice(0, 6).toLowerCase()}`,
      alpha: alphaFromByte(parseInt(value.slice(6, 8), 16)),
    };
  }
  const hex = normalizeHex(value);
  return hex ? { hex, alpha: 100 } : null;
}

export function formatHexAlpha(hex: string, alpha: number): string {
  return `${normalizeHex(hex) ?? '#ffffff'}${alphaToByteHex(alpha)}`;
}

const SWATCHES: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: '#ffffff', label: 'White' },
  { hex: '#0f172a', label: 'Ink' },
  { hex: '#64748b', label: 'Slate' },
  { hex: '#2563eb', label: 'Blue' },
  { hex: '#059669', label: 'Green' },
  { hex: '#f59e0b', label: 'Amber' },
  { hex: '#e11d48', label: 'Rose' },
  { hex: '#7c3aed', label: 'Violet' },
];

interface PickerElements {
  area: HTMLElement;
  knob: HTMLElement;
  hue: HTMLInputElement;
  alpha: HTMLInputElement;
  alphaValue: HTMLElement;
  hex: HTMLInputElement;
  preview: HTMLElement;
  swatches: HTMLElement;
  transparent: HTMLButtonElement;
}

function queryElements(root: HTMLElement): PickerElements {
  const find = <T extends Element>(name: string): T => {
    const el = root.querySelector<T>(`[data-picker="${name}"]`);
    if (!el) throw new Error(`Colour picker is missing [data-picker="${name}"].`);
    return el;
  };
  return {
    area: find('area'),
    knob: find('knob'),
    hue: find('hue'),
    alpha: find('alpha'),
    alphaValue: find('alphaValue'),
    hex: find('hex'),
    preview: find('preview'),
    swatches: find('swatches'),
    transparent: find('transparent'),
  };
}

export interface ColorPickerControl {
  /** The button the popover is currently anchored to, or null when closed. */
  readonly anchor: HTMLElement | null;
  open(anchor: HTMLElement, choice: BackgroundChoice, onChange: (choice: BackgroundChoice) => void): void;
  toggle(anchor: HTMLElement, choice: BackgroundChoice, onChange: (choice: BackgroundChoice) => void): void;
  close(): void;
  /** Mirror an externally changed choice into the open picker. */
  syncFor(anchor: HTMLElement, choice: BackgroundChoice): void;
}

interface PickerState extends Hsv {
  alpha: number;
  transparent: boolean;
}

export function createColorPicker(root: HTMLElement): ColorPickerControl {
  const el = queryElements(root);
  let anchor: HTMLElement | null = null;
  let onChange: ((choice: BackgroundChoice) => void) | null = null;
  let frame = 0;
  let state: PickerState = { h: 0, s: 0, v: 1, alpha: 100, transparent: true };

  for (const swatch of SWATCHES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'colorPickerSwatch';
    button.dataset.hex = swatch.hex;
    button.style.setProperty('--swatch', swatch.hex);
    button.setAttribute('aria-label', swatch.label);
    button.title = swatch.label;
    button.addEventListener('click', () => {
      applyHex(swatch.hex);
      emit();
    });
    el.swatches.appendChild(button);
  }

  function hex(): string {
    return hsvToHex(state);
  }

  function render(skipHexInput = false): void {
    const current = hex();
    el.area.style.setProperty('--picker-hue', hsvToHex({ h: state.h, s: 1, v: 1 }));
    el.knob.style.left = `${state.s * 100}%`;
    el.knob.style.top = `${(1 - state.v) * 100}%`;
    el.hue.value = String(Math.round(state.h));
    el.alpha.value = String(Math.round(state.alpha));
    el.alpha.style.setProperty('--picker-color', current);
    el.alphaValue.textContent = `${Math.round(state.alpha)}%`;
    el.preview.style.setProperty('--preview', state.transparent ? 'transparent' : toRgba(choiceFor(state)));
    el.transparent.setAttribute('aria-pressed', String(state.transparent));
    if (!skipHexInput && document.activeElement !== el.hex) el.hex.value = current.slice(1);
  }

  function choiceFor(value: PickerState): BackgroundChoice {
    return { kind: 'color', hex: hsvToHex(value), alpha: Math.round(value.alpha) };
  }

  function applyHex(value: string): void {
    const hsv = hexToHsv(value);
    state = { ...state, ...hsv, transparent: false };
  }

  function applyChoice(choice: BackgroundChoice): void {
    state = { ...hexToHsv(choice.hex), alpha: choice.alpha, transparent: isTransparent(choice) };
  }

  function emit(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!onChange) return;
      onChange(
        state.transparent
          ? { kind: 'transparent', hex: hex(), alpha: 100 }
          : choiceFor(state),
      );
    });
  }

  function position(): void {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    root.style.visibility = 'hidden';
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    const left = clamp(rect.right - width, 8, Math.max(8, window.innerWidth - width - 8));
    const below = rect.bottom + 8;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 8) : below;
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.visibility = '';
  }

  function close(): void {
    if (!anchor) return;
    anchor.setAttribute('aria-expanded', 'false');
    anchor = null;
    onChange = null;
    root.hidden = true;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  function open(target: HTMLElement, choice: BackgroundChoice, change: (choice: BackgroundChoice) => void): void {
    if (anchor && anchor !== target) anchor.setAttribute('aria-expanded', 'false');
    anchor = target;
    onChange = change;
    applyChoice(choice);
    render();
    root.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    position();
  }

  function updateFromPointer(event: PointerEvent): void {
    const rect = el.area.getBoundingClientRect();
    state.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    state.v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
    state.transparent = false;
    render();
    emit();
  }

  el.area.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    el.area.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  });
  el.area.addEventListener('pointermove', (event) => {
    if (event.buttons) updateFromPointer(event);
  });

  el.hue.addEventListener('input', () => {
    state.h = Number(el.hue.value);
    state.transparent = false;
    render();
    emit();
  });
  el.alpha.addEventListener('input', () => {
    state.alpha = Number(el.alpha.value);
    state.transparent = false;
    render();
    emit();
  });
  el.hex.addEventListener('input', () => {
    const normalized = normalizeHex(el.hex.value);
    if (!normalized) return;
    applyHex(normalized);
    render(true);
    emit();
  });
  el.hex.addEventListener('blur', () => {
    el.hex.value = hex().slice(1);
  });
  el.transparent.addEventListener('click', () => {
    state.transparent = true;
    render();
    emit();
  });

  document.addEventListener('pointerdown', (event) => {
    if (root.hidden) return;
    const target = event.target as Node;
    if (root.contains(target) || anchor?.contains(target)) return;
    close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || root.hidden) return;
    const previous = anchor;
    close();
    previous?.focus();
  });
  window.addEventListener('resize', () => {
    if (!root.hidden) position();
  });

  return {
    get anchor() {
      return anchor;
    },
    open,
    toggle(target, choice, change) {
      if (anchor === target && !root.hidden) close();
      else open(target, choice, change);
    },
    close,
    syncFor(target, choice) {
      if (anchor !== target || root.hidden) return;
      applyChoice(choice);
      render();
    },
  };
}
