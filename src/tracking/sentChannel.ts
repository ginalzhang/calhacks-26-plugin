/**
 * Mirror of every message the Worker sent to the helper, for window.__steady.sentToHelper().
 * The Worker posts each record on a BroadcastChannel (WorkerToPage has no message for it; see
 * DECISIONS.md › Contract change requests).
 */
export const SENT_CHANNEL = "steady-sent-to-helper";

export type SentRecord = { t: string; id: string; at: number } & Record<string, unknown>;
