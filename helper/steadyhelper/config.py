"""Constants shared by the helper modules. Mirrors src/desktop/protocol.ts."""

WS_HOST = "127.0.0.1"
WS_PORT = 8765
ALLOWED_ORIGIN = "http://localhost:3000"
BAD_ORIGIN_CLOSE_CODE = 4003
#: Close code sent to the older Worker when a newer one connects (one Worker at a time).
REPLACED_CLOSE_CODE = 4001

PLUGIN_HOST = "127.0.0.1"
PLUGIN_PORT = 8766
PLUGIN_RECONNECT_S = 2.0
PLUGIN_REPLY_TIMEOUT_S = 5.0

#: Release the button when no message has arrived for this long (seconds).
WATCHDOG_S = 0.300
#: Watchdog poll period (seconds).
WATCHDOG_TICK_S = 0.020

#: Coalesce moves to at most this rate.
MAX_MOVE_HZ = 120.0
MIN_MOVE_INTERVAL_S = 1.0 / MAX_MOVE_HZ

#: `keys`: wait at most this long for Krita to become frontmost after activation.
ACTIVATE_WAIT_S = 0.150
ACTIVATE_POLL_S = 0.010

#: After a click with reactivate_krita, wait this long so the click lands in Chrome first.
REACTIVATE_DELAY_S = 0.120

#: krita_window_rect broadcast period.
WINDOW_RECT_PERIOD_S = 1.0
#: How often the main-thread Cocoa run loop is pumped (keeps NSWorkspace.frontmostApplication fresh).
RUNLOOP_PUMP_S = 0.050

KRITA_BUNDLE_ID = "org.kde.krita"
PHOTOSHOP_BUNDLE_ID = "com.adobe.Photoshop"

#: `--app` / STEADY_APP choices (P4 "any drawing app"): which app keys go to, which app's
#: window rect is reported and which app (besides Chrome) consumes the global keys.
#: Only Krita has a plugin; for the others the helper never connects to port 8766.
APP_BUNDLES = {"krita": KRITA_BUNDLE_ID, "photoshop": PHOTOSHOP_BUNDLE_ID}
CHROME_BUNDLE_IDS = frozenset(
    {
        "com.google.Chrome",
        "com.google.Chrome.beta",
        "com.google.Chrome.dev",
        "com.google.Chrome.canary",
        "org.chromium.Chromium",
        "com.google.chrome.for.testing",
    }
)

#: macOS virtual keycodes of the §4 default keys → `hotkey` names.
#: F10 is push-to-talk: press → ptt_down, release → ptt_up.
FKEY_KEYCODES = {
    "f3": 99,
    "f4": 118,
    "f5": 96,
    "f6": 97,
    "f7": 98,
    "f8": 100,
    "f9": 101,
    "f10": 109,
}
DEFAULT_HOTKEYS = {
    "f8": "pen",
    "f9": "pause",
    "f10": "ptt",  # special: ptt_down / ptt_up
    "f7": "undo",
    "f6": "redo",
    "f5": "recenter",
    "f4": "other_hand",
    "f3": "latch",
}

HOTKEY_NAMES = frozenset(
    ["pen", "pause", "ptt_down", "ptt_up", "undo", "redo", "recenter", "other_hand", "latch"]
)

PRIVACY_ACCESSIBILITY_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
PRIVACY_INPUT_MONITORING_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
