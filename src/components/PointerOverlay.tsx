"use client";
/**
 * Full-viewport, click-through overlay: Steady's cursor and dwell ring (§3, §0 rule 6). State is never
 * colour-only: the cursor is filled (pen down), hollow (pen up) or a "?" ring (tracking lost); a grey
 * dashed ring means a dwell here would do nothing. prefers-reduced-motion: the ring fills in steps.
 */
import { useEffect, useRef } from "react";
import type { MirrorState, PipelineOutput, Vec2 } from "../pipeline/types";

interface Props {
  getFrame: () => PipelineOutput | null;
  getMirror: () => MirrorState | null;
}

/** Screen points → this page's viewport px (CSS px = points at 100 % zoom). */
export function screenToViewport(p: Vec2): Vec2 {
  const top = window.outerHeight - window.innerHeight;
  return { x: p.x - window.screenX, y: p.y - window.screenY - top };
}

export function PointerOverlay({ getFrame, getMirror }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const f = getFrame();
      const m = getMirror();
      if (!f || !m) return;
      const conv = (p: Vec2) => (m.target === "krita" ? screenToViewport(p) : p);
      const lost = m.tracking === "Lost";
      const ptr = f.pointer ?? m.pointer;
      if (!ptr) return;
      const p = conv(ptr);
      const drawing = m.pen === "DRAWING";

      // Dwell ring around the anchor.
      const d = f.dwell;
      if (d.kind && !lost) {
        const a = conv({ x: d.x, y: d.y });
        let prog = Math.max(0, Math.min(1, d.progress));
        if (reduced.matches) prog = Math.floor(prog * 4) / 4;
        const R = 26;
        ctx.lineWidth = 5;
        ctx.setLineDash(d.gated ? [6, 6] : []);
        ctx.strokeStyle = d.gated ? "rgba(140,140,140,0.9)" : "rgba(0,0,0,0.35)";
        ctx.beginPath();
        ctx.arc(a.x, a.y, R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (!d.gated && prog > 0) {
          ctx.strokeStyle = d.kind === "pen_up" ? "#d1495b" : d.kind === "click" ? "#2563eb" : "#0f8a4b";
          ctx.beginPath();
          ctx.arc(a.x, a.y, R, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
          ctx.stroke();
        }
      }

      // Cursor.
      ctx.lineWidth = 3;
      if (lost) {
        ctx.strokeStyle = "#b45309";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#b45309";
        ctx.font = "bold 20px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("?", p.x, p.y + 1);
        return;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, drawing ? 7 : 10, 0, Math.PI * 2);
      if (drawing) {
        ctx.fillStyle = "#111";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.stroke();
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fill();
        ctx.strokeStyle = m.paused ? "#6b7280" : "#111";
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [getFrame, getMirror]);

  return <canvas ref={ref} className="pointer-overlay" aria-hidden="true" />;
}
