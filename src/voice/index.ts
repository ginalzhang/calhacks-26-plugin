/**
 * Agent E public surface (client-side). B imports from here.
 *   <MicTile {...MicTileProps}/>            pinned-header Mic tile
 *   resolveText(text, {mode, dialogOpen, context})   typed box + voice share this path
 *   resolveClarify(accepted)                 call when a Claude clarify prompt closes
 *   prewarmClaude()                          once at app start
 *   speakConfirmation(kind, heard?)          "saved" | "new_layer" | "didnt_catch" | "needs_plugin" | "skin_saved" | "brush_named" | "word_taken"
 *   tts.setEnabled / tts.setQuiet / tts.onStatus / cancelSpeech()
 *   claude log: readClaudeLog / summariseClaudeLog / onClaudeLogChange / markLastClaudeRejected / clearClaudeLog
 */
export { default as MicTile } from "./MicTile";
export { resolveText, resolveClarify, pickContext, isAliasTaken } from "./resolve";
export { prewarmClaude } from "./prewarm";
export { tts, cancelSpeech, speakConfirmation, confirmationText, type ConfirmationKind, type TtsStatus } from "./ttsClient";
export {
  readClaudeLog,
  summariseClaudeLog,
  onClaudeLogChange,
  markLastClaudeRejected,
  clearClaudeLog,
  type ClaudeLogEntry,
  type ClaudeLogSummary,
} from "./claudeLog";
