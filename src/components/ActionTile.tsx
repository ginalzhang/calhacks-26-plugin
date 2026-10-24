"use client";
/** A tile generated from the action table: label from `ACTIONS`, disabled when its tile phase has not landed. */
import { ACTIONS_BY_ID, BUILD_PHASE, phaseAtMost, tilePhaseOf } from "../actions";
import { Tile } from "./Tile";

export interface ActionTileProps {
  id: string;
  run: (id: string, el: HTMLElement | null) => void;
  pressed?: boolean;
  label?: string;
  span?: 1 | 2 | 3;
  disabled?: boolean;
  children?: React.ReactNode;
}

export function tileAvailable(id: string): boolean {
  const a = ACTIONS_BY_ID[id];
  return !!a && phaseAtMost(tilePhaseOf(a), BUILD_PHASE);
}

export function ActionTile({ id, run, pressed, label, span, disabled, children }: ActionTileProps) {
  const a = ACTIONS_BY_ID[id];
  if (!a) return null;
  const available = tileAvailable(id);
  return (
    <Tile
      label={label ?? a.label}
      action={id}
      span={span}
      pressed={a.toggle ? !!pressed : undefined}
      disabled={!available || disabled}
      title={available ? a.help : `${a.label}: coming in ${tilePhaseOf(a)}`}
      variant={a.destructive ? "danger" : "default"}
      onPress={(el) => run(id, el)}
    >
      {children}
    </Tile>
  );
}
