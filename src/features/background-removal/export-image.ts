// Export helpers: transparent PNG (real alpha) and white-background JPG.

export function canvasToPngDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

export function canvasToJpegDataUrl(canvas: HTMLCanvasElement): string {
  // Draw the transparent canvas onto a pure-white canvas, then export JPG.
  const white = document.createElement('canvas');
  white.width = canvas.width;
  white.height = canvas.height;
  const ctx = white.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, white.width, white.height);
  ctx.drawImage(canvas, 0, 0);
  return white.toDataURL('image/jpeg', 0.92);
}