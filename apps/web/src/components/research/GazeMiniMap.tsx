import { useEffect, useRef } from 'react';

/**
 * Tiny normalized 2D mini-map of recent gaze samples (Stage 5 fallback —
 * no screen-recording in this platform, so the gaze overlay-on-video idea
 * from the spec is replaced with this widget in the inspector).
 *
 * Coordinates are normalized 0..1 against the recording-time viewport
 * (read from `viewport_logs` upstream — for now we just normalize against
 * the observed min/max of (x, y) in the trail window).
 */

type Props = {
  trail: { tMs: number; x: number; y: number }[]; // most recent first
  current: { x: number; y: number; conf: number | null } | null;
  /** Width in CSS px. Aspect ratio is fixed 16:9. */
  width?: number;
};

export function GazeMiniMap({ trail, current, width = 240 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const height = Math.round((width * 9) / 16);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Background.
    ctx.fillStyle = 'rgba(120, 113, 108, 0.12)';
    ctx.fillRect(0, 0, width, height);

    // Compute domain from the trail union with the current point.
    const all = [...trail];
    if (current) all.push({ tMs: 0, x: current.x, y: current.y });
    if (all.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of all) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || maxX === minX) {
      minX = 0;
      maxX = 1;
    }
    if (!Number.isFinite(minY) || maxY === minY) {
      minY = 0;
      maxY = 1;
    }
    const padX = (maxX - minX) * 0.05;
    const padY = (maxY - minY) * 0.05;
    minX -= padX;
    maxX += padX;
    minY -= padY;
    maxY += padY;

    const xToPx = (x: number) => ((x - minX) / (maxX - minX)) * width;
    const yToPx = (y: number) => ((y - minY) / (maxY - minY)) * height;

    // Trail (oldest faintest).
    if (trail.length > 1) {
      ctx.strokeStyle = 'rgba(82, 130, 145, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      // trail expected ordered oldest first -> newest last; but we accept any
      // order, just render in place.
      for (let i = 0; i < trail.length; i++) {
        const p = trail[i]!;
        const x = xToPx(p.x);
        const y = yToPx(p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i]!;
      const alpha = 0.15 + 0.7 * (i / Math.max(1, trail.length - 1));
      ctx.fillStyle = `rgba(82, 130, 145, ${alpha})`;
      ctx.beginPath();
      ctx.arc(xToPx(p.x), yToPx(p.y), 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Current position.
    if (current) {
      ctx.strokeStyle = 'rgba(220, 38, 38, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(xToPx(current.x), yToPx(current.y), 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(220, 38, 38, 0.5)';
      ctx.beginPath();
      ctx.arc(xToPx(current.x), yToPx(current.y), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [trail, current, width, height]);

  return (
    <div
      className="border border-stone-200 dark:border-stone-700 rounded overflow-hidden"
      style={{ width, height }}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
