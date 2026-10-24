"use client";
/**
 * Practice canvas (§0 P0): strokes drawn with perfect-freehand from Worker frames; in Demo mode the
 * live trace (last 3 s of the raw path, faded, under the smoothed path). Renders on rAF (may pause;
 * the pointer never does: it lives in the Worker).
 */
import getStroke from "perfect-freehand";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { MirrorState, Vec2 } from "../pipeline/types";
import type { StrokeStore } from "./strokes";

export interface PracticeCanvasHandle {
  el: HTMLCanvasElement | null;
  focus(): void;
}

interface Props {
  store: StrokeStore;
  demo: boolean;
  getMirror: () => MirrorState | null;
}

function outlinePath(points: Vec2[]): Path2D {
  const outline = getStroke(
    points.map((p) => [p.x, p.y]),
    { size: 7, thinning: 0.35, smoothing: 0.5, streamline: 0, simulatePressure: false, last: true },
  );
  const path = new Path2D();
  if (!outline.length) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) path.lineTo(outline[i][0], outline[i][1]);
  path.closePath();
  return path;
}

export const PracticeCanvas = forwardRef<PracticeCanvasHandle, Props>(function PracticeCanvas({ store, demo, getMirror }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cache = useRef(new Map<Vec2[], Path2D>());

  useImperativeHandle(ref, () => ({
    get el() {
      return canvasRef.current;
    },
    focus() {
      canvasRef.current?.focus();
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let drawnVersion = -1;
    let size = { w: 0, h: 0, dpr: 1 };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size = { w: r.width, h: r.height, dpr };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      drawnVersion = -1;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!demo && drawnVersion === store.version) return;
      drawnVersion = store.version;
      const r = canvas.getBoundingClientRect();
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      ctx.fillStyle = "#fbfaf7";
      ctx.fillRect(0, 0, size.w, size.h);

      if (demo) {
        const m = getMirror();
        if (m && m.target === "canvas" && m.rawTrail.length > 1) {
          ctx.strokeStyle = "rgba(200, 40, 40, 0.35)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          m.rawTrail.forEach((p, i) => (i ? ctx.lineTo(p.x - r.left, p.y - r.top) : ctx.moveTo(p.x - r.left, p.y - r.top)));
          ctx.stroke();
        }
        if (m && m.target === "canvas" && store.trail.length > 1) {
          ctx.strokeStyle = "rgba(20, 90, 200, 0.6)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          store.trail.forEach((p, i) => (i ? ctx.lineTo(p.x - r.left, p.y - r.top) : ctx.moveTo(p.x - r.left, p.y - r.top)));
          ctx.stroke();
        }
      }

      ctx.fillStyle = "#1a1a1a";
      for (const s of store.done) {
        let p = cache.current.get(s);
        if (!p) {
          p = outlinePath(s);
          cache.current.set(s, p);
        }
        ctx.fill(p);
      }
      if (store.current && store.current.length) ctx.fill(outlinePath(store.current));
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [store, demo, getMirror]);

  return (
    <canvas
      ref={canvasRef}
      className="practice-canvas"
      role="img"
      aria-label="Practice canvas"
      tabIndex={0}
      data-testid="practice-canvas"
    />
  );
});
