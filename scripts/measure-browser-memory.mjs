// In-browser peak memory for the 512 model.
//
// Samples the RSS of every Chromium process (renderer + utility) from /proc
// while a smoke run executes. External sampling is used deliberately: it
// captures the WASM linear-memory growth and the worker's allocations, which
// performance.memory (JS heap only) does not report.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const IMAGE = process.argv[2] || 'glass-wine.jpg';
const OUT = `smoke-results/measurements/browser-memory-${IMAGE.replace(/\W/g, '_')}.json`;

function treeRssKb(rootPid) {
  // Collect the root and all descendants, so workers and the GPU/network
  // utility processes are counted too.
  let out;
  try {
    out = execSync(
      `ps -e -o pid=,ppid=,rss= | awk '$1==${rootPid} || $2==${rootPid} {print $1}'`,
      { encoding: 'utf8' },
    );
  } catch {
    return { total: 0, procs: [] };
  }
  const pids = new Set([String(rootPid), ...out.split(/\s+/).filter(Boolean)]);
  // Walk a second level for children of children.
  for (const p of [...pids]) {
    try {
      const kids = execSync(`ps -e -o pid=,ppid= | awk '$2==${p} {print $1}'`, { encoding: 'utf8' })
        .split(/\s+/).filter(Boolean);
      kids.forEach((k) => pids.add(k));
    } catch {}
  }
  let total = 0;
  const procs = [];
  for (const p of pids) {
    try {
      const rss = parseInt(
        execSync(`ps -o rss= -p ${p}`, { encoding: 'utf8' }).trim(), 10,
      );
      if (!Number.isNaN(rss)) { total += rss; procs.push([p, rss]); }
    } catch {}
  }
  return { total, procs };
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
  protocolTimeout: 300000,
  timeout: 300000,
});
const pid = browser.process().pid;
const page = await browser.newPage();

const baseline = treeRssKb(pid).total;

await page.goto('http://localhost:5173/?provider=wasm', { waitUntil: 'load', timeout: 60000 });

let peak = 0;
const samples = [];
const timer = setInterval(() => {
  const r = treeRssKb(pid).total;
  samples.push(r);
  if (r > peak) peak = r;
}, 150);

await page.waitForFunction('window.smokeModelReady===true', { timeout: 180000, polling: 500 });
const afterModel = treeRssKb(pid).total;

const [chooser] = await Promise.all([
  page.waitForFileChooser({ timeout: 20000 }),
  page.click('#pickFile'),
]);
await chooser.accept([`test-images/${IMAGE}`]);
await page.waitForFunction(() => !!document.querySelector('#inputBox img'), { timeout: 20000, polling: 250 });

const t0 = Date.now();
await page.evaluate(() => document.getElementById('runAll').click());
await page.waitForFunction(
  () => document.getElementById('stage').textContent === 'Done' ||
        document.getElementById('stage').textContent.startsWith('Error'),
  { timeout: 280000, polling: 500 },
);
const elapsed = Date.now() - t0;
clearInterval(timer);

const afterRun = treeRssKb(pid).total;
const last = await page.evaluate(() => ({
  stage: document.getElementById('stage').textContent,
  log: document.getElementById('log').textContent,
  // WASM linear memory is visible via the ORT runtime's wasm env when present.
  provider: window.smokeProvider,
}));

const MB = (kb) => Math.round(kb / 1024);
const result = {
  image: IMAGE,
  provider: last.provider,
  stage: last.stage,
  elapsed_s: +(elapsed / 1000).toFixed(1),
  baseline_mb: MB(baseline),
  after_model_load_mb: MB(afterModel),
  after_run_mb: MB(afterRun),
  peak_mb: MB(peak),
  peak_above_baseline_mb: MB(peak - baseline),
  samples_n: samples.length,
  timings: (last.log.match(/Inference \d+: [\d.]+ ms/g) || []),
};

writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

await browser.close();
