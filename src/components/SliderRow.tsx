"use client";
/**
 * Slider with − and + tiles either side (§0 rule 6). The native range with aria-valuetext is the keyboard
 * path; the tiles are the dwell path. Names: "<label> down" / "<label> up"; the range is labelled <label>.
 */
import { useId } from "react";

export interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Step for the ± tiles (5, or 50 ms for times). */
  tileStep: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}

export function SliderRow({ label, value, min, max, step, tileStep, format, onChange, disabled }: SliderRowProps) {
  const id = useId();
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const text = format(value);
  return (
    <div className="slider-row" data-slider={label}>
      <button
        type="button"
        className="tile tile-default slider-step"
        aria-label={`${label} down`}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - tileStep))}
      >
        <span aria-hidden="true">−</span>
      </button>
      <div className="slider-mid">
        <div className="slider-head">
          <label htmlFor={id}>{label}</label>
          <span className="slider-value" aria-hidden="true">
            {text}
          </span>
        </div>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={text}
          disabled={disabled}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
        />
      </div>
      <button
        type="button"
        className="tile tile-default slider-step"
        aria-label={`${label} up`}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + tileStep))}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}
