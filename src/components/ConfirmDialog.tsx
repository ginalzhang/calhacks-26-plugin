"use client";
/**
 * Modal alertdialog (§0 rule 6): aria-modal, focus trap, focus on Cancel at open, focus returned to the
 * invoking tile on close, the confirm tile is labelled "Confirm", Esc cancels. Also used for clarify
 * prompts (numbered option tiles "One/Two/Three" + Cancel).
 */
import { useEffect, useId, useRef } from "react";

export interface DialogSpec {
  kind: "confirm" | "choose";
  title: string;
  body?: string;
  /** confirm: run on Confirm. */
  onConfirm?: () => void;
  /** choose: option tiles. */
  options?: Array<{ label: string; run: () => void }>;
  /** Run when the dialog closes without a choice (Cancel, Esc, voice "no"). */
  onCancel?: () => void;
  returnFocus?: HTMLElement | null;
}

const NUMBER_WORDS = ["One", "Two", "Three"];

export function ConfirmDialog({ spec, onClose }: { spec: DialogSpec; onClose: (how: "cancel" | "done") => void }) {
  const titleId = useId();
  const bodyId = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const returnTo = spec.returnFocus ?? (document.activeElement as HTMLElement | null);
    cancelRef.current?.focus();
    return () => {
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, [spec]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose("cancel");
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={spec.body ? bodyId : undefined}
        className="dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="dialog-title">
          {spec.title}
        </h2>
        {spec.body && (
          <p id={bodyId} className="dialog-body">
            {spec.body}
          </p>
        )}
        <div className="tile-grid">
          {spec.kind === "choose" &&
            spec.options?.map((o, i) => (
              <button
                key={o.label}
                type="button"
                className="tile tile-default span-3"
                data-action={`choice_${["one", "two", "three"][i]}`}
                onClick={() => {
                  onClose("done");
                  o.run();
                }}
              >
                <span className="tile-label">
                  {NUMBER_WORDS[i]}: {o.label}
                </span>
              </button>
            ))}
          <button
            ref={cancelRef}
            type="button"
            className="tile tile-default"
            data-action="cancel"
            onClick={() => onClose("cancel")}
          >
            <span className="tile-label">Cancel</span>
          </button>
          {spec.kind === "confirm" && (
            <button
              type="button"
              className="tile tile-danger span-2"
              data-action="yes"
              onClick={() => {
                onClose("done");
                spec.onConfirm?.();
              }}
            >
              <span className="tile-label">Confirm</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
