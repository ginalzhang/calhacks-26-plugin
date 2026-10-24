# Steady: hour-0 setup for a human (about 20 minutes)

You do not need to be technical. Do these four things in order, tick each box in `NEEDS-HUMAN.md`
as you go, and write down anything that did not work exactly as described. Nothing here can be done by
the build agents: it needs your hands, your Mac's permission dialogs, your iPhone and your camera.

You need: the Mac (macOS 14 or newer), Google Chrome, an iPhone (for the camera) with a USB cable,
a free table with something to rest your forearm on (a book or a rolled towel), and optionally a USB
foot pedal.

> **If no human has ticked these by the end of P1, the build treats Desk View as absent and carries on.**

---

## 0. Start Steady (5 min)

1. Open **Terminal**: press `⌘ Space`, type `Terminal`, press Return.
2. Go to the project folder. Type `cd ` (with a space), drag the project folder from Finder into the
   Terminal window, press Return.
3. Type `npm install` and press Return, then `npm run assets` and Return (only the first time; each
   waits until the prompt comes back). The second one downloads the hand-tracking model so tracking works
   without the internet.
4. Type `npm run dev` and press Return. Leave this window open. When it prints `Ready`, Steady is running.
   If it says port 3000 is already in use, something else is running there: quit it (or ask a developer to
   run Steady on port 3100 with `npx next dev -p 3100` and start the helper with
   `npm run helper -- --origin http://localhost:3100`).
5. Open a **second** Terminal window (`⌘ N`), `cd` into the same folder again, and type
   `npm run demo-chrome`. A separate Chrome window opens at `http://localhost:3000?demo=1`. It uses its
   own profile, so your normal Chrome, tabs and logins are untouched.

---

## 1. Does Chrome list "Desk View"? (5 min)

1. Plug the iPhone into the Mac **with a USB cable** (wired is more reliable than wireless).
   Unlock the iPhone. Put it on a stand or lean it so it looks **down at the desk** where your hand will
   rest (landscape works best).
2. In the Steady Chrome window, when Chrome asks to use the camera, click **Allow**.
3. In Steady's side panel click the **Setup** tab, then open the **camera** dropdown.
4. Look for an entry with **"Desk View"** in its name.
   - **Listed:** choose it. Tick "Desk View listed" in `NEEDS-HUMAN.md`.
   - **Not listed:** choose the entry with your iPhone's name (a plain Continuity Camera). Aim the phone
     down at the desk yourself. Tick "Desk View NOT listed; using wired iPhone" in `NEEDS-HUMAN.md`.
   - **No iPhone at all:** choose the built-in camera and tilt the laptop screen so it sees the desk.
     Write that down too.
5. If the picture is mirrored (your hand moves right, the picture moves left), tap **Mirror camera** on the
   Setup page. If it is upside down, tap **Rotate camera**.

---

## 2. Permissions, and switch off things that fight Steady (5 min)

The helper moves the real mouse pointer and listens for the F-keys / pedal. macOS gives that power to the
**app that launched the helper**: that is **Terminal** (or iTerm, or whatever you used), not "python".

1. In a Terminal window in the project folder, type `npm run helper` and press Return. It will say which
   permissions are missing. Leave it running.
2. **Accessibility:** open this link in Safari or paste it into Chrome's address bar:
   `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
   (or: Apple menu  › System Settings › Privacy & Security › Accessibility).
   Find **Terminal** in the list and switch it **on**. If it is not in the list, click **+**, open
   Applications › Utilities › Terminal, click Open, then switch it on.
3. **Input Monitoring:** `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`
   (or: System Settings › Privacy & Security › Input Monitoring). Switch **Terminal** on the same way.
4. **Camera and Microphone for Chrome:** `x-apple.systempreferences:com.apple.preference.security?Privacy_Camera`
   and `...?Privacy_Microphone`. Make sure **Google Chrome** is on in both.
5. **Quit and reopen Terminal** (`⌘ Q`, then open it again) so the new permissions take effect, then run
   `npm run helper` again. It should no longer complain about permissions.
6. **Turn OFF macOS features that also move the pointer or listen for the same words**
   (System Settings › Accessibility):
   - **Voice Control** (Accessibility › Voice Control): off.
   - **Pointer Control** (Accessibility › Pointer Control): turn off anything named **Dwell**,
     **Head pointer**, or **Alternate pointer actions**.
7. **Unplug any drawing tablet** (Wacom, Huion, XP-Pen…). Krita can lock itself into tablet mode and
   ignore the mouse until it restarts.
8. **F-keys:** if pressing F8 changes screen brightness or volume instead, go to System Settings ›
   Keyboard › Keyboard Shortcuts… › Function Keys and switch on
   **"Use F1, F2, etc. keys as standard function keys"**. A Mac with a Touch Bar or no F-keys can use a
   USB foot pedal or a cheap USB keypad instead: set it to send **F8** (pen) and **F9** (pause).

If the pointer ever seems stuck, **click the physical mouse or trackpad once**. That always releases it.

---

## 3. Krita and the Steady plugin (10 min)

1. Install **Krita 5.3.2.1** (or another 5.3.x) from <https://krita.org/en/download/>. Do **not** use
   Krita 6. Open it once, then quit it.
2. In a Terminal in the project folder: `npm run krita-plugin:install`.
3. Open Krita. Menu **Settings › Configure Krita…** (on a Mac this can also be under
   **Krita › Preferences…**) › **Python Plugin Manager** › tick **Steady** › OK. **Quit and reopen Krita.**
4. Follow `scripts/krita-setup.md` (enlarge the toolbox icons, lock the dockers, pick a preset whose size
   follows **Speed** rather than Pressure).
5. With the helper running, open or create a document in Krita. Steady's status line should say the Krita
   plugin is connected.

---

## 4. Does Chrome keep running beside Krita? (2 min)

1. Make the Steady Chrome window a narrow strip (about 320 px wide) at the side of the screen, and Krita
   fill the rest. Never put Chrome **fully behind** Krita.
2. Click inside Krita so Krita is the active app.
3. Watch the **fps** number in Steady's header for 30 seconds. It must keep updating (not freeze, not drop
   to 0). Tick the box in `NEEDS-HUMAN.md` with the number you saw (e.g. "fps stayed at 29–30").

---

## When you are done

Tick each box in `NEEDS-HUMAN.md` and add one line of what you saw. If something failed, write the exact
words on screen. Do not try to fix code; the build agents will read your notes.
