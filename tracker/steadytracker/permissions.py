"""Panel `permissions`: camera, microphone, accessibility, input_monitoring (booleans).

All four are attributed by macOS to the responsible app: "Steady Tracker" when launched with
`open -a "Steady Tracker"`, the terminal app when run from a shell. `probe()` only READS the grants
(AVCaptureDevice.authorizationStatusForMediaType_, AXIsProcessTrusted, CGPreflightListenEventAccess),
so it never shows a prompt. `request_startup()` (real runs only, never with --no-input or in tests)
asks for camera access when undetermined, the Accessibility prompt, and Input Monitoring listing.
"""

from __future__ import annotations

import logging
from typing import Dict

log = logging.getLogger("steady.tracker.permissions")

AUTHORIZED = 3  # AVAuthorizationStatusAuthorized
NOT_DETERMINED = 0


def _av_status(media: str) -> int:
    import AVFoundation as AVF

    mt = AVF.AVMediaTypeVideo if media == "video" else AVF.AVMediaTypeAudio
    return int(AVF.AVCaptureDevice.authorizationStatusForMediaType_(mt))


def probe() -> Dict[str, bool]:
    out = {"camera": False, "microphone": False, "accessibility": False, "input_monitoring": False}
    try:
        out["camera"] = _av_status("video") == AUTHORIZED
        out["microphone"] = _av_status("audio") == AUTHORIZED
    except Exception:
        log.debug("AVFoundation status unavailable", exc_info=True)
    try:
        from ApplicationServices import AXIsProcessTrusted

        out["accessibility"] = bool(AXIsProcessTrusted())
    except Exception:
        log.debug("AXIsProcessTrusted unavailable", exc_info=True)
    try:
        import Quartz

        out["input_monitoring"] = bool(Quartz.CGPreflightListenEventAccess())
    except Exception:
        log.debug("CGPreflightListenEventAccess unavailable", exc_info=True)
    return out


def request_startup(camera: bool = True) -> None:
    """Real runs only. Shows the system prompts once (attributed to the responsible app)."""
    if camera:
        try:
            if _av_status("video") == NOT_DETERMINED:
                import AVFoundation as AVF

                AVF.AVCaptureDevice.requestAccessForMediaType_completionHandler_(
                    AVF.AVMediaTypeVideo, lambda granted: log.info("camera access %s", "granted" if granted else "denied")
                )
        except Exception:
            log.exception("camera access request failed")
    try:
        from steadyhelper.permissions import check_permissions

        check_permissions(prompt=True, app_name="Steady Tracker")
    except Exception:
        log.exception("accessibility / input monitoring request failed")


def request_microphone() -> None:
    """When the mic first opens and access is undetermined (real runs only)."""
    try:
        if _av_status("audio") == NOT_DETERMINED:
            import AVFoundation as AVF

            AVF.AVCaptureDevice.requestAccessForMediaType_completionHandler_(
                AVF.AVMediaTypeAudio, lambda granted: log.info("microphone access %s", "granted" if granted else "denied")
            )
    except Exception:
        log.exception("microphone access request failed")


def permissions_message(state: Dict[str, bool]) -> Dict[str, object]:
    return {
        "t": "permissions",
        "camera": bool(state.get("camera")),
        "microphone": bool(state.get("microphone")),
        "accessibility": bool(state.get("accessibility")),
        "input_monitoring": bool(state.get("input_monitoring")),
    }
