/**
 * Agent E public surface (client-side). B imports from here.
 *   <MicTile {...MicTileProps}/>            pinned-header Mic tile
 *   resolveText(text, {mode, dialogOpen, context})   typed box + voice share this path
 *   resolveClarify(accepted)                 call when a Claude clarify prompt closes
 *   prewarmClaude()                          once at app start
 *   tts.speak("Saved") / tts.setEnabled / tts.setQuiet / cancelSpeech()
 *   claude log: readClaudeLog / summariseClaudeLog / onClaudeLogChange / markLastClaudeRejected / clearClaudeLog
 */
export { default as MicTile } from "./MicTile";
export { resolveText, resolveClarify, pickContext } from "./resolve";
export { prewarmClaude } from "./prewarm";
export { tts, cancelSpeech } from "./ttsClient";
export {
  readClaudeLog,
  summariseClaudeLog,
  onClaudeLogChange,
  markLastClaudeRejected,
  clearClaudeLog,
  type ClaudeLogEntry,
  type ClaudeLogSummary,
} from "./claudeLog";
