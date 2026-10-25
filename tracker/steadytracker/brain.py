"""The brain child process: `node tracker/brain/dist/brain.mjs`, one JSON object per line.

stdout lines → `on_message(dict)` (reader thread); stderr → log; `send(dict)` from any thread.
When the process ends without `stop()` having been called, `on_exit(returncode)` fires once (reader
thread); the app releases the button and restarts it once (app.TrackerApp._on_brain_exit).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger("steady.tracker.brain")


def default_brain_cmd(bundle: str) -> List[str]:
    node = os.environ.get("STEADY_NODE") or "node"
    return [node, bundle]


class BrainProcess:
    def __init__(
        self,
        cmd: List[str],
        on_message: Callable[[Dict[str, Any]], None],
        on_exit: Optional[Callable[[Optional[int]], None]] = None,
        *,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> None:
        self.cmd = list(cmd)
        self._on_message = on_message
        self._on_exit = on_exit
        self.cwd = cwd
        self.env = env
        self.proc: Optional[subprocess.Popen] = None
        self._wlock = threading.Lock()
        self._stopping = False
        self.lines_in = 0
        self.lines_out = 0

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> None:
        self._stopping = False
        env = dict(os.environ if self.env is None else self.env)
        # Keys stay in the tracker; the brain never needs them.
        for k in ("CARTESIA_API_KEY", "ANTHROPIC_API_KEY"):
            env.pop(k, None)
        self.proc = subprocess.Popen(
            self.cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=self.cwd,
            env=env,
            bufsize=0,
        )
        proc = self.proc
        threading.Thread(target=self._read_stdout, args=(proc,), name="steady-brain-out", daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(proc,), name="steady-brain-err", daemon=True).start()
        log.info("brain started (pid %d): %s", proc.pid, " ".join(self.cmd))

    def send(self, msg: Dict[str, Any]) -> bool:
        proc = self.proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            return False
        data = (json.dumps(msg, separators=(",", ":")) + "\n").encode("utf-8")
        with self._wlock:
            try:
                proc.stdin.write(data)
                proc.stdin.flush()
                self.lines_out += 1
                return True
            except (BrokenPipeError, OSError, ValueError):
                return False

    def _read_stdout(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        try:
            for raw in iter(proc.stdout.readline, b""):
                line = raw.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    log.warning("brain printed a non-JSON line: %r", line[:200])
                    continue
                if not isinstance(msg, dict) or "t" not in msg:
                    continue
                self.lines_in += 1
                try:
                    self._on_message(msg)
                except Exception:
                    log.exception("brain message handler failed for %r", msg.get("t"))
        except (OSError, ValueError):
            pass
        code = None
        try:
            code = proc.wait(timeout=2)
        except Exception:
            pass
        if proc is self.proc and not self._stopping:
            log.error("brain exited unexpectedly (code %s)", code)
            if self._on_exit:
                try:
                    self._on_exit(code)
                except Exception:
                    log.exception("on_exit failed")

    def _read_stderr(self, proc: subprocess.Popen) -> None:
        assert proc.stderr is not None
        try:
            for raw in iter(proc.stderr.readline, b""):
                text = raw.decode("utf-8", "replace").rstrip()
                if text:
                    log.info("[brain] %s", text)
        except (OSError, ValueError):
            pass

    def stop(self, timeout: float = 1.0) -> None:
        self._stopping = True
        proc = self.proc
        if proc is None:
            return
        if proc.poll() is None:
            self.send({"t": "shutdown"})
            try:
                if proc.stdin:
                    proc.stdin.close()
            except Exception:
                pass
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    proc.kill()
