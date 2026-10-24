/**
 * Practice-canvas strokes, built from Worker frames (not React state). Owned by B.
 * Points are canvas-local CSS px.
 */
import type { PipelineOutput, Vec2 } from "../pipeline/types";

export class StrokeStore {
  done: Vec2[][] = [];
  redoStack: Vec2[][] = [];
  current: Vec2[] | null = null;
  version = 0;
  private listeners = new Set<() => void>();

  /** Smoothed pointer trail (last 3 s, viewport px) for the Demo live trace. */
  trail: Array<Vec2 & { t: number }> = [];

  constructor(private origin: () => Vec2) {}

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private local(p: Vec2): Vec2 {
    const o = this.origin();
    return { x: p.x - o.x, y: p.y - o.y };
  }

  /** Feed one Worker frame (practice target only). Returns true when a stroke was committed. */
  feed(out: PipelineOutput): boolean {
    let committed = false;
    for (const e of out.events) {
      if (e.type === "down") {
        this.current = [this.local(e)];
      } else if (e.type === "move") {
        if (this.current) this.current.push(this.local(e));
      } else if (e.type === "up") {
        if (this.current) {
          this.current.push(this.local(e));
          this.done.push(this.current);
          this.redoStack = [];
          committed = true;
        }
        this.current = null;
      }
    }
    if (out.pen === "DRAWING" && !this.current && out.pointer) this.current = [this.local(out.pointer)];
    if (out.pointer) {
      this.trail.push({ ...out.pointer, t: out.t });
      while (this.trail.length && this.trail[0].t < out.t - 3000) this.trail.shift();
    }
    if (out.events.length || this.current) this.bump();
    return committed;
  }

  undo(): boolean {
    const s = this.done.pop();
    if (!s) return false;
    this.redoStack.push(s);
    this.bump();
    return true;
  }

  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.done.push(s);
    this.bump();
    return true;
  }

  clear() {
    this.done = [];
    this.redoStack = [];
    this.current = null;
    this.trail = [];
    this.bump();
  }

  count() {
    return this.done.length;
  }
}
