// Clean Light SaaS Command Palette (⌘K / Ctrl+K): pure filtering + navigation
// logic paired with accessible DOM bindings. Keeping the query matcher and key
// stepping pure lets unit tests verify every behavior without a browser.

export type CommandCategory = 'Studio' | 'Samples' | 'Navigation' | 'Appearance';

export type CommandAction =
  | { type: 'open-studio'; tab?: 'step' | 'bulk' | 'library' }
  | { type: 'load-sample'; url: string; filename: string }
  | { type: 'scroll-to'; selector: string }
  | { type: 'set-theme'; mode: 'light' | 'dark' | 'system' };

export interface CommandItem {
  id: string;
  label: string;
  description: string;
  category: CommandCategory;
  shortcut?: string;
  keywords: readonly string[];
  action: CommandAction;
}

export const COMMAND_ITEMS: readonly CommandItem[] = [
  {
    id: 'studio-open',
    label: 'Open Studio Workspace',
    description: 'Launch the full-screen background removal editor',
    category: 'Studio',
    shortcut: 'S',
    keywords: ['studio', 'remove', 'upload', 'editor', 'cutout', 'png'],
    action: { type: 'open-studio', tab: 'step' },
  },
  {
    id: 'studio-bulk',
    label: 'Batch Process Photos (Bulk)',
    description: 'Queue up to five product photos and download a ZIP archive',
    category: 'Studio',
    shortcut: 'B',
    keywords: ['bulk', 'batch', 'zip', 'multiple', 'five', 'ecommerce'],
    action: { type: 'open-studio', tab: 'bulk' },
  },
  {
    id: 'studio-library',
    label: 'Open Session Library',
    description: 'Inspect cut-outs created during this browser session',
    category: 'Studio',
    shortcut: 'L',
    keywords: ['library', 'history', 'session', 'versions', 'recent'],
    action: { type: 'open-studio', tab: 'library' },
  },
  {
    id: 'sample-bottle',
    label: 'Try Sample: Scent Bottle',
    description: 'Load high-res product photo into Studio and run segmentation',
    category: 'Samples',
    keywords: ['sample', 'product', 'bottle', 'cosmetic', 'demo'],
    action: {
      type: 'load-sample',
      url: './test-images/product-scent-bottle.jpg',
      filename: 'product-scent-bottle.jpg',
    },
  },
  {
    id: 'sample-dog',
    label: 'Try Sample: Hair & Fur (Dog)',
    description: 'Test fine fur edge matting directly in Studio',
    category: 'Samples',
    keywords: ['sample', 'dog', 'hair', 'fur', 'pet', 'animal', 'demo'],
    action: {
      type: 'load-sample',
      url: './test-images/animal-buddy-dog.jpg',
      filename: 'animal-buddy-dog.jpg',
    },
  },
  {
    id: 'sample-glass',
    label: 'Try Sample: Translucent Wine Glass',
    description: 'Inspect glass reflections and transparency handling in Studio',
    category: 'Samples',
    keywords: ['sample', 'glass', 'wine', 'crystal', 'transparent', 'demo'],
    action: {
      type: 'load-sample',
      url: './test-images/glass-wine.jpg',
      filename: 'glass-wine.jpg',
    },
  },
  {
    id: 'nav-showcase',
    label: 'Jump to Interactive Showcase',
    description: 'Compare 9 real before/after model outputs',
    category: 'Navigation',
    keywords: ['showcase', 'examples', 'before', 'after', 'compare', 'slider'],
    action: { type: 'scroll-to', selector: '#showcase' },
  },
  {
    id: 'nav-how',
    label: 'Jump to Architecture & Formats',
    description: 'Inspect the 4-stage local pipeline and export capabilities',
    category: 'Navigation',
    keywords: ['architecture', 'how', 'pipeline', 'formats', 'png', 'webp', 'jpg'],
    action: { type: 'scroll-to', selector: '#how' },
  },
  {
    id: 'nav-benchmarks',
    label: 'Jump to 64-Image Benchmarks',
    description: 'Review evaluation parity, inference latency, and category stats',
    category: 'Navigation',
    keywords: ['benchmarks', 'metrics', 'iou', 'latency', 'cpu', 'webgpu', 'wasm'],
    action: { type: 'scroll-to', selector: '#benchmarks' },
  },
  {
    id: 'nav-support',
    label: 'Jump to Capabilities Reference',
    description: 'Plain-language guide on limits, privacy, and hardware routing',
    category: 'Navigation',
    keywords: ['support', 'limits', 'privacy', 'hardware', 'webgpu'],
    action: { type: 'scroll-to', selector: '#support' },
  },
  {
    id: 'nav-faq',
    label: 'Jump to FAQ',
    description: 'Answers on offline cache, privacy, and image sizes',
    category: 'Navigation',
    keywords: ['faq', 'questions', 'help', 'privacy', 'offline'],
    action: { type: 'scroll-to', selector: '#faq' },
  },
  {
    id: 'theme-light',
    label: 'Theme: Clean Light Mode',
    description: 'Pin interface to Clean Light SaaS mode',
    category: 'Appearance',
    keywords: ['theme', 'light', 'bright', 'day', 'mode'],
    action: { type: 'set-theme', mode: 'light' },
  },
  {
    id: 'theme-dark',
    label: 'Theme: Dark Mode',
    description: 'Pin interface to dark zinc mode',
    category: 'Appearance',
    keywords: ['theme', 'dark', 'night', 'mode'],
    action: { type: 'set-theme', mode: 'dark' },
  },
  {
    id: 'theme-system',
    label: 'Theme: Follow System',
    description: 'Sync appearance with OS color-scheme preference',
    category: 'Appearance',
    keywords: ['theme', 'system', 'auto', 'os'],
    action: { type: 'set-theme', mode: 'system' },
  },
];

/** Filter command items by multi-term case-insensitive token matching. */
export function filterCommands(
  items: readonly CommandItem[],
  query: string,
): CommandItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];
  const terms = normalized.split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const haystack = `${item.label} ${item.description} ${item.category} ${item.keywords.join(' ')}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Next active option index for keyboard navigation, or null when unhandled. */
export function stepCommandIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export interface CommandPaletteCallbacks {
  onAction: (action: CommandAction) => void;
}

export function initCommandPalette(
  callbacks: CommandPaletteCallbacks,
  root: Document = document,
): { open: () => void; close: () => void } {
  const dialog = root.getElementById('cmdPalette');
  const input = root.getElementById('cmdPaletteInput') as HTMLInputElement | null;
  const list = root.getElementById('cmdPaletteList');
  const empty = root.getElementById('cmdPaletteEmpty');
  const triggers = Array.from(root.querySelectorAll<HTMLElement>('[data-cmd-open]'));
  const closers = Array.from(root.querySelectorAll<HTMLElement>('[data-cmd-close]'));

  if (!dialog || !input || !list) {
    return { open: () => {}, close: () => {} };
  }

  let visibleItems: CommandItem[] = [...COMMAND_ITEMS];
  let activeIndex = 0;
  let lastTrigger: HTMLElement | null = null;

  const isOpen = (): boolean => !dialog.hidden;

  const renderList = (): void => {
    list.textContent = '';
    if (visibleItems.length === 0) {
      if (empty) empty.hidden = false;
      activeIndex = -1;
      return;
    }
    if (empty) empty.hidden = true;
    if (activeIndex < 0 || activeIndex >= visibleItems.length) activeIndex = 0;

    let lastCat: CommandCategory | null = null;
    visibleItems.forEach((item, index) => {
      if (item.category !== lastCat) {
        lastCat = item.category;
        const heading = root.createElement('div');
        heading.className = 'cmdGroupLabel';
        heading.textContent = item.category;
        list.appendChild(heading);
      }
      const btn = root.createElement('button');
      btn.type = 'button';
      btn.role = 'option';
      btn.className = index === activeIndex ? 'cmdOption is-active' : 'cmdOption';
      btn.setAttribute('aria-selected', String(index === activeIndex));
      btn.dataset.cmdIndex = String(index);

      const textWrap = root.createElement('span');
      textWrap.className = 'cmdOptionMain';

      const title = root.createElement('span');
      title.className = 'cmdOptionTitle';
      title.textContent = item.label;

      const desc = root.createElement('span');
      desc.className = 'cmdOptionDesc';
      desc.textContent = item.description;

      textWrap.append(title, desc);
      btn.appendChild(textWrap);

      if (item.shortcut) {
        const kbd = root.createElement('kbd');
        kbd.className = 'cmdKbd';
        kbd.textContent = item.shortcut;
        btn.appendChild(kbd);
      }

      btn.addEventListener('mouseenter', () => {
        activeIndex = index;
        syncActiveClass();
      });
      btn.addEventListener('click', () => executeIndex(index));
      list.appendChild(btn);
    });
  };

  const syncActiveClass = (): void => {
    const options = list.querySelectorAll<HTMLButtonElement>('.cmdOption');
    options.forEach((opt) => {
      const idx = Number(opt.dataset.cmdIndex ?? '-1');
      const on = idx === activeIndex;
      opt.classList.toggle('is-active', on);
      opt.setAttribute('aria-selected', String(on));
      if (on) opt.scrollIntoView({ block: 'nearest' });
    });
  };

  const open = (): void => {
    if (isOpen()) return;
    lastTrigger = root.activeElement as HTMLElement | null;
    dialog.hidden = false;
    input.value = '';
    visibleItems = [...COMMAND_ITEMS];
    activeIndex = 0;
    renderList();
    requestAnimationFrame(() => input.focus());
  };

  const close = (): void => {
    if (!isOpen()) return;
    dialog.hidden = true;
    lastTrigger?.focus?.();
  };

  const executeIndex = (index: number): void => {
    const item = visibleItems[index];
    if (!item) return;
    close();
    callbacks.onAction(item.action);
  };

  triggers.forEach((btn) => btn.addEventListener('click', open));
  closers.forEach((el) => el.addEventListener('click', close));

  input.addEventListener('input', () => {
    visibleItems = filterCommands(COMMAND_ITEMS, input.value);
    activeIndex = 0;
    renderList();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      executeIndex(activeIndex);
      return;
    }
    const next = stepCommandIndex(event.key, activeIndex, visibleItems.length);
    if (next !== null) {
      event.preventDefault();
      activeIndex = next;
      syncActiveClass();
    }
  });

  root.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (isOpen()) close();
      else open();
    } else if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  return { open, close };
}
