"use client";

import { useEffect, useRef } from "react";

export const NODES = ["Bond MUSD & Assert", "1,440-Block Window", "Settle / Resolve"] as const;
export const R = 7;
export const ACCENT = "oklch(0.628 0.2577 19.23)";
export const DIM = "rgba(127,127,127,0.3)";
const REDUCED = "(prefers-reduced-motion: reduce)";

export function HowItWorks() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const [dpr, w, h] = [window.devicePixelRatio || 1, el.clientWidth, R * 8];
    Object.assign(el, { width: w * dpr, height: h * dpr });
    ctx.scale(dpr, dpr);
    const [y, step] = [h / 2, (w - R * 4) / (NODES.length - 1)];
    const xs = NODES.map((_, i) => R * 2 + i * step);
    let raf = 0;
    const circle = (x: number, r: number, fill?: string, stroke?: string, alpha = 1) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.globalAlpha = alpha;
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    const frame = (t: number) => {
      const [head, lit] = [(t * 0.3) % 1, Math.floor(((t * 0.3) % 1) * NODES.length)];
      ctx.clearRect(0, 0, w, h);
      Object.assign(ctx, { strokeStyle: DIM, lineWidth: 1 });
      ctx.beginPath();
      ctx.moveTo(xs[0], y);
      ctx.lineTo(xs[xs.length - 1], y);
      ctx.stroke();
      xs.forEach((x, i) => {
        circle(x, R, i <= lit ? ACCENT : DIM);
        if (i === lit) circle(x, R + 4 + Math.sin(t * 3) * 2, undefined, ACCENT, 0.4);
      });
      circle(xs[0] + head * (xs[xs.length - 1] - xs[0]), 2.5, ACCENT);
    };
    if (window.matchMedia(REDUCED).matches) return void frame(0);
    const start = performance.now();
    const draw = (now: number) => {
      frame((now - start) / 1000);
      raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !raf) raf = requestAnimationFrame(draw);
      else if (!e.isIntersecting) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <section id="how-it-works" aria-label="How it works" className="scroll-mt-14 bg-background py-24">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 sm:px-6">
        <h2 className="font-mono text-muted-foreground text-xs uppercase tracking-wider">How it works</h2>
        <canvas ref={canvas} aria-hidden className="h-14 w-full max-w-md" />
        <ol className="grid max-w-md grid-cols-3 gap-2 font-mono text-[11px] uppercase">
          {NODES.map((label, i) => (
            <li key={label} className="flex flex-col gap-1 border-primary/40 border-t pt-2 text-muted-foreground">
              <span className="font-bold text-primary">{String(i + 1).padStart(2, "0")}</span>
              {label}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
