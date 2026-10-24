/**
 * Lazy-brush dead zone (friction 0): the pointer moves only when the pre-point is more than
 * `radius` away, and is then dragged so it sits exactly `radius` behind the pre-point.
 */
import type { Vec2 } from "./types";

export class LazyBrush {
  radius: number;
  private p: Vec2 | null = null;

  constructor(radius: number) {
    this.radius = radius;
  }

  reset(at: Vec2 | null = null): void {
    this.p = at ? { x: at.x, y: at.y } : null;
  }

  get pointer(): Vec2 | null {
    return this.p ? { x: this.p.x, y: this.p.y } : null;
  }

  /** Feed the pre-point; returns the pointer. The first point initialises the pointer in place. */
  update(pre: Vec2): Vec2 {
    if (!this.p) {
      this.p = { x: pre.x, y: pre.y };
      return { ...this.p };
    }
    const dx = pre.x - this.p.x;
    const dy = pre.y - this.p.y;
    const d = Math.hypot(dx, dy);
    if (d > this.radius) {
      const k = (d - this.radius) / d;
      this.p = { x: this.p.x + dx * k, y: this.p.y + dy * k };
    }
    return { x: this.p.x, y: this.p.y };
  }
}
