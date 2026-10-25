#!/usr/bin/env bash
# Builds build/Steady Tracker.app: the hidden (LSUIElement) app the Krita panel launches with
#   open -g -a "Steady Tracker" --args --panel-port 8767
# Launched through LaunchServices, it is the "responsible process" for everything it starts, so macOS
# asks for and attributes Camera, Microphone, Accessibility and Input Monitoring to "Steady Tracker"
# (not to Krita, python or node). Run from a terminal instead (scripts/run-tracker.sh) and the terminal
# app gets the prompts.
#
#   bash scripts/build-tracker-app.sh             # build/Steady Tracker.app (ad-hoc signed)
#   bash scripts/build-tracker-app.sh --install   # ...and copy it to ~/Applications/Steady Tracker.app
#
# Contents/MacOS/steady-tracker is a tiny compiled launcher (clang from the Command Line Tools) that
# cd's to this repo (absolute path baked in), spawns `bash scripts/run-tracker.sh "$@"` as a CHILD and
# forwards SIGTERM/SIGINT/SIGHUP. A child keeps the app as its responsible process; a script that
# `exec`s python would turn the app process itself into Python.app, whose Info.plist has no camera
# usage text. Without clang the executable falls back to a bash script (attribution unverified).
# stdout/stderr go to ~/Library/Logs/Steady/tracker.log when not attached to a terminal.
#
# Ad-hoc signatures change on every rebuild, and macOS may then forget the grants: build once, grant,
# and rebuild only when this script changes. STEADY_BUILD_DIR overrides the output folder (tests).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
INSTALL=0
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
OUT=${STEADY_BUILD_DIR:-$REPO/build}
APP="$OUT/Steady Tracker.app"
VERSION=$(grep -E '^VERSION' tracker/steadytracker/__init__.py | sed -E 's/.*"(.*)".*/\1/')
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>org.steady.tracker</string>
  <key>CFBundleName</key><string>Steady Tracker</string>
  <key>CFBundleDisplayName</key><string>Steady Tracker</string>
  <key>CFBundleExecutable</key><string>steady-tracker</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCameraUsageDescription</key><string>Steady watches your resting hand to move the pointer. Frames never leave this Mac.</string>
  <key>NSMicrophoneUsageDescription</key><string>Steady listens only while the Mic is open, to turn your voice into commands.</string>
</dict>
</plist>
PLIST
plutil -lint -s "$APP/Contents/Info.plist"

EXE="$APP/Contents/MacOS/steady-tracker"
CC=$(xcrun --find clang 2>/dev/null || command -v cc || true)
SDK=$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)
BUILT=0
if [ -n "$CC" ]; then
  SRC=$(mktemp -d)/launcher.c
  ESC=$(printf '%s' "$REPO" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  cat > "$SRC" <<C
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
static const char *REPO = "${ESC}";
static volatile pid_t child = 0;
static void fwd(int sig) { if (child > 0) kill(child, sig); }
int main(int argc, char **argv) {
  if (chdir(REPO) != 0) { perror("Steady Tracker: repo not found"); return 1; }
  if (!isatty(1)) {
    const char *home = getenv("HOME");
    if (home) {
      char dir[4096], path[4096]; struct stat st;
      snprintf(dir, sizeof dir, "%s/Library/Logs/Steady", home);
      mkdir(dir, 0755);
      snprintf(path, sizeof path, "%s/tracker.log", dir);
      int flags = O_WRONLY | O_CREAT | O_APPEND;
      if (stat(path, &st) == 0 && st.st_size > 5 * 1024 * 1024) flags |= O_TRUNC;
      int fd = open(path, flags, 0644);
      if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); close(fd); }
    }
  }
  char script[4096];
  snprintf(script, sizeof script, "%s/scripts/run-tracker.sh", REPO);
  char **args = calloc((size_t)argc + 3, sizeof(char *));
  int n = 0;
  args[n++] = "/bin/bash";
  args[n++] = script;
  for (int i = 1; i < argc; i++) if (strncmp(argv[i], "-psn_", 5) != 0) args[n++] = argv[i];
  args[n] = NULL;
  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = fwd;
  sigaction(SIGTERM, &sa, NULL); sigaction(SIGINT, &sa, NULL); sigaction(SIGHUP, &sa, NULL);
  pid_t pid;
  int rc = posix_spawn(&pid, "/bin/bash", NULL, NULL, args, environ);
  if (rc != 0) { fprintf(stderr, "Steady Tracker: spawn failed: %s\n", strerror(rc)); return 1; }
  child = pid;
  int status = 0;
  while (waitpid(pid, &status, 0) < 0) { if (errno != EINTR) return 1; }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
}
C
  if "$CC" -O2 -Wall -mmacosx-version-min=12.0 ${SDK:+-isysroot "$SDK"} -o "$EXE" "$SRC"; then
    BUILT=1
  fi
  rm -rf "$(dirname "$SRC")"
fi
if [ "$BUILT" = 0 ]; then
  echo "warning: could not compile the launcher; using a bash launcher (camera attribution unverified)" >&2
  cat > "$EXE" <<SH
#!/bin/bash
cd "$REPO" || exit 1
[ -t 1 ] || { mkdir -p "\$HOME/Library/Logs/Steady"; exec >>"\$HOME/Library/Logs/Steady/tracker.log" 2>&1; }
/bin/bash "$REPO/scripts/run-tracker.sh" "\$@"
SH
fi
chmod +x "$EXE"
codesign --force --deep -s - "$APP"
codesign --verify "$APP"
echo "Built $APP"

if [ "$INSTALL" = 1 ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Steady Tracker.app"
  ditto "$APP" "$HOME/Applications/Steady Tracker.app"
  echo "Installed $HOME/Applications/Steady Tracker.app"
  echo "Launch: open -g -a \"Steady Tracker\" --args --panel-port 8767"
fi
