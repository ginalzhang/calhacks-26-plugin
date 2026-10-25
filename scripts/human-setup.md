# Steady: setup for a human (about 20 minutes)

You do not need to be technical. Do these steps in order, tick each box in `NEEDS-HUMAN.md` as you go,
and write down anything that did not work exactly as described. Nothing here can be done by the build
agents: it needs your hands, your Mac's permission dialogs, your camera and Krita.

Steady is a **Krita plugin**: a **Steady panel** inside Krita, plus a small hidden app called
**"Steady Tracker"** that the panel starts. Steady Tracker is the one that uses the camera, the
microphone and the mouse pointer, so **macOS will ask for permissions for "Steady Tracker"** (not for
Krita, not for Terminal, not for "python").

You need: the Mac (Apple silicon, macOS 14 or newer), **Krita 5.3** in Applications, a camera (an iPhone
with a USB cable is best; the built-in camera works if it can see the desk), the keyboard and the mouse or
touchpad, and a free table with something to rest your forearm on (a book or a rolled towel).

---

## 0. Run the installer (5–10 min, once)

1. Open **Terminal**: press `⌘ Space`, type `Terminal`, press Return.
2. Go to the project folder. Type `cd ` (with a space), drag the project folder from Finder into the
   Terminal window, press Return.
3. Optional, to see what it will do without changing anything: `bash scripts/install-steady.sh --dry-run`
4. Type `bash scripts/install-steady.sh` and press Return. Wait until it prints **"Install finished."**
   - If it says **MISSING: Python 3.12**, type `brew install python@3.12`, press Return, wait, then run the
     installer again.
   - If it says **MISSING: Krita**, install Krita 5.3 first (see `scripts/krita-setup.md` §1), then run it again.
   - Copy any line that starts with **WARNING** into `NEEDS-HUMAN.md`.
5. Running it again later is safe: it skips what is already done.

**API keys (optional):** voice uses Cartesia and unclear commands use Claude. If you have keys, copy
`.env.example` to `.env.local` in the project folder and fill in `CARTESIA_API_KEY=` and
`ANTHROPIC_API_KEY=`. Without them Steady still works with tiles, keys and the typed box; the panel says
"key missing" for voice.

---

## 1. Turn the plugin on in Krita (3 min, once)

1. Open Krita.
2. Click **krita** in the menu bar (top-left, next to the Apple) › **Preferences…**
   (on other systems: **Settings › Configure Krita…**).
3. Click **Python Plugin Manager** in the list on the left. Tick **Steady**. Click **OK**.
   If it was already ticked, leave it.
4. **Quit Krita (`⌘ Q`) and open it again.** Plugins only load when Krita starts. Do this every time the
   installer has run.
5. Check: menu **Tools › Scripts › Steady: connection status** says **listening on 127.0.0.1:8766**.

## 2. Open the Steady panel (1 min)

1. Open or create a picture (**File › New**).
2. Menu **Settings › Dockers › Steady**. The Steady panel appears.
3. Drag it to the left or right edge of the window so it docks beside the canvas.
4. Follow `scripts/krita-setup.md` once (bigger toolbox icons, lock the dockers, a brush whose size follows
   **Speed** rather than Pressure).

## 3. Press Start and allow the permissions (5 min, once)

1. Put the camera in place first: plug the iPhone in **with a USB cable**, unlock it, and stand it so it
   looks **down at the desk** where your hand will rest. (No iPhone: the built-in camera, laptop screen tilted
   so it sees the desk.)
2. In the Steady panel press **Start**.
3. macOS asks: **"Steady Tracker" would like to access the camera** → **Allow**. Then the same for the
   **microphone** → **Allow**.
4. Now the two permissions macOS does not ask for in a dialog. Open each link in Safari (or paste it into
   any browser's address bar), or go to Apple menu  › System Settings › Privacy & Security:
   - **Accessibility** (lets Steady move the pointer):
     `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
   - **Input Monitoring** (lets Steady hear the F-keys while Krita is in front):
     `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`

   In each list, switch **Steady Tracker** **on**. If it is not in the list, click **+**, find
   **Steady Tracker** (the installer prints where it put it), click Open, then switch it on.
5. Back in Krita, press **Stop**, then **Start** again so the new permissions take effect.
   The panel shows which permissions are granted; if one is still missing, it says which, and for which app.

## 4. Switch off things that fight Steady (2 min)

System Settings › Accessibility:
- **Voice Control**: off.
- **Pointer Control**: turn off anything named **Dwell**, **Head pointer** or **Alternate pointer actions**.

Also:
- **Unplug any drawing tablet** (Wacom, Huion, XP-Pen…) and turn off iPad Sidecar. Krita can lock itself into
  tablet mode and ignore the pointer until it restarts.
- **F-keys:** if F8 changes screen brightness or volume instead, go to System Settings › Keyboard ›
  Keyboard Shortcuts… › Function Keys and switch on **"Use F1, F2, etc. keys as standard function keys"**.

If the pointer ever seems stuck, **click the physical mouse or touchpad once**. That always releases it.

## 5. Pick the camera and paint (5 min)

1. In the panel's **camera** list, look for an entry with **"Desk View"** in its name.
   - **Listed:** choose it. Write "Desk View listed" in `NEEDS-HUMAN.md` item 5.
   - **Not listed:** choose the entry with your iPhone's name and aim the phone down at the desk yourself.
   - **No iPhone:** choose the built-in camera. Write down which one you used.
2. The small preview shows your hand with a dot on the index knuckle. If moving your hand right moves the dot
   or the pointer left, use the panel's **Mirror** setting; if it is upside down, **Rotate**.
3. Press **Calibrate** and follow the panel: hold still (3 s), draw an easy circle (4 s), move right then
   away (3 s).
4. Rest your forearm on the towel, fingers curled loosely. The pointer follows your hand.
5. Hold still about a second over Krita's canvas: the pen goes **down**. Move: a stroke appears in Krita.
   Hold still again: the pen **lifts**.
6. With a Cartesia key: tap **Mic** (or hold **F10**) and say "blue", "bigger", "undo that".

---

## When you are done

Tick each box in `NEEDS-HUMAN.md` and add one line of what you saw. If something failed, write the exact
words on screen. Do not try to fix code; the build agents will read your notes.

## Fallback: the website version

Only if the plugin build fails and you need the old demo: the website runs in a dedicated Chrome window
beside Krita. Commands and permissions (granted to **Terminal**, not Steady Tracker, in that version) are in
README › "Fallback: website version" and `NEEDS-HUMAN.md` › "Fallback: website version".
