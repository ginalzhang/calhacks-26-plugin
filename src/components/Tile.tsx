"use client";
/**
 * A side-panel tile (§0 rule 6): a real <button> with a text label, ≥ 64×64 px, 18 px text.
 * Toggles expose aria-pressed with a fixed name; the Pause tile is renamed Resume and has NO aria-pressed.
 */
import type { ReactNode } from "react";

export interface TileProps {
  label: string;
  onPress: (el: HTMLButtonElement) => void;
  /** Toggle state; undefined = not a toggle (no aria-pressed). */
  pressed?: boolean;
  disabled?: boolean;
  /** Action id (data-action) for tests and the dwell hit-test. */
  action?: string;
  span?: 1 | 2 | 3;
  ariaLabel?: string;
  title?: string;
  children?: ReactNode;
  variant?: "default" | "danger" | "primary";
  current?: boolean;
  id?: string;
}

export function Tile({
  label,
  onPress,
  pressed,
  disabled,
  action,
  span = 1,
  ariaLabel,
  title,
  children,
  variant = "default",
  current,
  id,
}: TileProps) {
  return (
    <button
      type="button"
      id={id}
      className={`tile tile-${variant}${span > 1 ? ` span-${span}` : ""}${current ? " tile-current" : ""}`}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-current={current ? "page" : undefined}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      data-action={action}
      onClick={(e) => onPress(e.currentTarget)}
    >
      <span className="tile-label">{label}</span>
      {children}
    </button>
  );
}
