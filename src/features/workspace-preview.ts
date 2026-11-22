// Interactive bindings for the Clean Light SaaS landing workspace:
// 1. Hero app-shell sample switcher tabs (updates the live compare preview + file telemetry)
// 2. Bento export-format preview selector (PNG Alpha / JPG White / WebP)
// 3. One-click sample launcher callbacks (`data-sample-url`)

export interface HeroSampleMeta {
  id: string;
  filename: string;
  dimensions: string;
  category: string;
  sampleUrl: string;
  beforeSrc: string;
  afterSrc: string;
  beforeAlt: string;
  afterAlt: string;
}

export const HERO_SAMPLES: readonly HeroSampleMeta[] = [
  {
    id: 'product',
    filename: 'product-scent-bottle.jpg',
    dimensions: '1024 × 1024',
    category: 'Product Silhouette',
    sampleUrl: './test-images/product-scent-bottle.jpg',
    beforeSrc: './demo/product-scent-bottle-before.webp',
    afterSrc: './demo/product-scent-bottle-after.webp',
    beforeAlt: 'Original photo of a scent bottle on a plain background',
    afterAlt: 'Scent bottle cut-out with background removed on transparency grid',
  },
  {
    id: 'fur',
    filename: 'animal-buddy-dog.jpg',
    dimensions: '1280 × 960',
    category: 'Hair & Fine Fur',
    sampleUrl: './test-images/animal-buddy-dog.jpg',
    beforeSrc: './demo/animal-buddy-dog-before.webp',
    afterSrc: './demo/animal-buddy-dog-after.webp',
    beforeAlt: 'Original photo of a dog against a solid backdrop',
    afterAlt: 'Dog cut-out preserving fine fur strands on transparency grid',
  },
  {
    id: 'glass',
    filename: 'glass-wine.jpg',
    dimensions: '1024 × 1024',
    category: 'Translucent Glass',
    sampleUrl: './test-images/glass-wine.jpg',
    beforeSrc: './demo/glass-wine-before.webp',
    afterSrc: './demo/glass-wine-after.webp',
    beforeAlt: 'Original photo of a clear wine glass',
    afterAlt: 'Wine glass cut-out retaining translucent optical reflections',
  },
];

export interface FormatSpecMeta {
  id: 'png' | 'jpg' | 'webp';
  title: string;
  detail: string;
  alpha: string;
  useCase: string;
}

export const FORMAT_SPECS: readonly FormatSpecMeta[] = [
  {
    id: 'png',
    title: 'PNG · Lossless RGBA',
    detail: 'Preserves full 8-bit alpha channel for crisp overlays and design tools.',
    alpha: 'True Transparency',
    useCase: 'Figma, Canva, Web UI, Print',
  },
  {
    id: 'jpg',
    title: 'JPG · Studio Matte',
    detail: 'Composites onto pure #FFFFFF or any custom swatch with compact file size.',
    alpha: 'Custom Solid Matte',
    useCase: 'Shopify, Amazon, Marketplaces',
  },
  {
    id: 'webp',
    title: 'WebP · Modern Web Alpha',
    detail: 'Combines transparent alpha channels with high web compression efficiency.',
    alpha: 'Compact Alpha',
    useCase: 'Fast Storefronts & CDN Assets',
  },
];

export function initLandingWorkspace(
  onLoadSample: (url: string, filename: string) => void,
  root: Document = document,
): void {
  // Hero App Shell sample switcher
  const heroTabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-hero-sample]'));
  const heroBefore = root.getElementById('heroCompareBefore') as HTMLImageElement | null;
  const heroAfter = root.getElementById('heroCompareAfter') as HTMLImageElement | null;
  const heroFilename = root.getElementById('heroShellFilename');
  const heroMeta = root.getElementById('heroShellMeta');
  const heroRunBtn = root.getElementById('heroRunSample') as HTMLButtonElement | null;

  let activeSample = HERO_SAMPLES[0];

  const selectHeroSample = (sampleId: string): void => {
    const found = HERO_SAMPLES.find((s) => s.id === sampleId);
    if (!found) return;
    activeSample = found;
    heroTabs.forEach((tab) => {
      const on = tab.dataset.heroSample === found.id;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    if (heroBefore) {
      heroBefore.src = found.beforeSrc;
      heroBefore.alt = found.beforeAlt;
    }
    if (heroAfter) {
      heroAfter.src = found.afterSrc;
      heroAfter.alt = found.afterAlt;
    }
    if (heroFilename) heroFilename.textContent = found.filename;
    if (heroMeta) heroMeta.textContent = `${found.dimensions} · ${found.category}`;
  };

  heroTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.heroSample;
      if (id) selectHeroSample(id);
    });
  });

  heroRunBtn?.addEventListener('click', () => {
    onLoadSample(activeSample.sampleUrl, activeSample.filename);
  });

  // Any explicit showcase/sample button
  root.querySelectorAll<HTMLElement>('[data-sample-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.sampleUrl;
      const name = btn.dataset.sampleName ?? 'sample.jpg';
      if (url) onLoadSample(url, name);
    });
  });

  // Bento Format Spec Tabs
  const formatTabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-format-tab]'));
  const formatTitle = root.getElementById('bentoFormatTitle');
  const formatDetail = root.getElementById('bentoFormatDetail');
  const formatAlpha = root.getElementById('bentoFormatAlpha');
  const formatUseCase = root.getElementById('bentoFormatUseCase');

  formatTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.formatTab;
      const spec = FORMAT_SPECS.find((f) => f.id === id);
      if (!spec) return;
      formatTabs.forEach((t) => {
        const on = t.dataset.formatTab === spec.id;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
      });
      if (formatTitle) formatTitle.textContent = spec.title;
      if (formatDetail) formatDetail.textContent = spec.detail;
      if (formatAlpha) formatAlpha.textContent = spec.alpha;
      if (formatUseCase) formatUseCase.textContent = spec.useCase;
    });
  });
}
