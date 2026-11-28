// Parallel background visual worker.
// Renders an ambient segmentation-like constellation on an OffscreenCanvas so
// the main thread stays free for ONNX Runtime and scroll gestures. This file
// never imports ONNX Runtime and never creates an ONNX session.

let canvas = null;
let ctx = null;
let width = 0;
let height = 0;
let dpr = 1;

let scrollProgress = 0;
let scrollVelocity = 0;
let pointer = { x: -9999, y: -9999 };
let paused = false;
let frameHandle = null;

const NODE_COUNT = 42;
const LINK_DISTANCE = 145;
let nodes = [];

function initNodes() {
  nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
    x: ((i * 97) % 100) / 100,
    y: ((i * 53) % 100) / 100,
    vx: ((i % 7) - 3) * 0.00025 || 0.0002,
    vy: ((i % 5) - 2) * 0.00025 || -0.0002,
    radius: 1.5 + (i % 3) * 0.8,
    hue: i % 2 === 0 ? '#8ab4f8' : '#c58af9',
  }));
}

function resize(w, h, ratio) {
  width = Math.max(1, w);
  height = Math.max(1, h);
  dpr = Math.min(ratio || 1, 2);
  if (!canvas) return;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawFrame() {
  ctx.clearRect(0, 0, width, height);

  const glowY = height * (0.25 + scrollProgress * 0.5);
  const glow = ctx.createRadialGradient(
    width * 0.5,
    glowY,
    20,
    width * 0.5,
    glowY,
    Math.max(width, height) * 0.65,
  );
  glow.addColorStop(0, 'rgba(138, 180, 248, 0.08)');
  glow.addColorStop(0.5, 'rgba(197, 138, 249, 0.04)');
  glow.addColorStop(1, 'rgba(19, 19, 20, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    n.x = (n.x + n.vx + 1) % 1;
    n.y = (n.y + n.vy - scrollVelocity * 0.00015 + 1) % 1;

    const px = n.x * width;
    const py = n.y * height;

    for (let j = i + 1; j < nodes.length; j++) {
      const m = nodes[j];
      const mx = m.x * width;
      const my = m.y * height;
      const dist = Math.hypot(px - mx, py - my);
      if (dist < LINK_DISTANCE) {
        ctx.strokeStyle = `rgba(138, 180, 248, ${(1 - dist / LINK_DISTANCE) * 0.14})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(mx, my);
        ctx.stroke();
      }
    }

    const pointerDist = Math.hypot(px - pointer.x, py - pointer.y);
    const boost = pointerDist < 160 ? (1 - pointerDist / 160) * 2.2 : 0;

    ctx.fillStyle = n.hue;
    ctx.globalAlpha = 0.45 + boost * 0.2;
    ctx.beginPath();
    ctx.arc(px, py, n.radius + boost, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function renderFrame() {
  frameHandle = null;
  if (!ctx || width === 0 || height === 0 || paused) return;
  scrollVelocity *= 0.92;
  drawFrame();
  frameHandle = requestAnimationFrame(renderFrame);
}

function start() {
  if (paused || frameHandle != null) return;
  frameHandle = requestAnimationFrame(renderFrame);
}

function stop() {
  if (frameHandle != null) {
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'init':
      canvas = msg.canvas;
      ctx = canvas.getContext('2d', { alpha: true });
      initNodes();
      resize(msg.width, msg.height, msg.dpr);
      if (msg.reducedMotion) {
        // A single static frame: no animation loop for reduced-motion users.
        if (ctx && width > 0 && height > 0) drawFrame();
      } else {
        start();
      }
      break;
    case 'resize':
      resize(msg.width, msg.height, msg.dpr);
      if (ctx && paused) drawFrame();
      break;
    case 'scroll':
      scrollProgress = msg.progress;
      scrollVelocity = msg.velocity;
      break;
    case 'pointer':
      pointer.x = msg.x;
      pointer.y = msg.y;
      break;
    case 'pause':
      paused = Boolean(msg.paused);
      if (paused) stop();
      else start();
      break;
  }
};
