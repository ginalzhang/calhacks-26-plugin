# Setting up Krita for Steady

This takes about 10 minutes, once. You need a Mac, Krita **5.3.x** and the Steady folder.
Nothing here needs a stylus or a tablet.

> The Steady plugin listens on `127.0.0.1` (this computer) only and sends nothing off the machine.

---

## 1. Install Krita 5.3

1. Go to <https://krita.org/en/download/> and download **Krita 5.3** for macOS (the `.dmg` file).
   Do **not** install Krita 6: it is a new, experimental version and Steady is tested on 5.3.
2. Open the `.dmg` and drag **krita** into **Applications**.
3. Open Krita once from Applications. If macOS says it can't check the app, right-click
   (or Control-click) **krita** in Applications, choose **Open**, then **Open** again.
4. Quit Krita (**krita › Quit krita**, or Cmd+Q).

## 2. Unplug any drawing tablet

Unplug any Wacom or other graphics tablet and turn off iPad Sidecar **before** you open Krita.
Krita can get stuck in "tablet mode" and ignore the mouse pointer until it is restarted, and Steady
moves the mouse pointer.

## 3. Copy the plugin into Krita

1. Open **Terminal** and go to the Steady folder (for example `cd ~/steady`).
2. Type `npm run krita-plugin:install` and press Return.
3. It prints where it put the files and what to do next. Running it again is safe.

## 4. Switch the plugin on

1. Open Krita.
2. Open Krita's settings: on a Mac, click **krita** in the menu bar (top-left, next to the Apple)
   › **Preferences…**. (On other systems this is **Settings › Configure Krita…**.)
3. In the list on the left, click **Python Plugin Manager**.
4. Find **Steady** in the list and tick its box.
5. Click **OK**.
6. Quit Krita (Cmd+Q) and open it again. Plugins only load when Krita starts.
7. Check it worked: menu **Tools › Scripts › Steady: connection status**. It should say
   **listening on 127.0.0.1:8766**. Once `npm run helper` is running it also says **helper connected**.

If **Steady** is not in the Python Plugin Manager list, run step 3 again and restart Krita.
If the status says **could not listen**, another copy of Krita is already open: quit all of them
and open just one.

## 5. What Steady changes in Krita, and how to undo it

When the Steady helper first connects to Krita, the plugin does two things and tells Steady, which
shows them in its status line:

- **Brush smoothing → None, once.** Steady smooths the hand itself; Krita smoothing on top adds lag
  and rounds corners. This happens once each time Krita starts (if no picture is open yet, it happens
  the first time you give a command with a picture open). Steady never changes it again, so if you
  prefer Krita's smoothing, set it back in the **Tool Options** docker of the Freehand Brush tool
  (**Brush Smoothing**: Basic, Weighted or Stabilizer) and Steady leaves it alone until Krita restarts.
- **Krita shortcuts on Steady's keys are cleared** (F3–F10). By default Krita uses F3 (layer
  properties), F4 (save incremental backup), **F5 (brush editor)** and **F6 (brush presets pop-up)**.
  Steady uses those keys for its foot pedal and switch controls, so Krita must not also react to them.
  The plugin clears them for the current Krita session.

To clear them permanently by hand (optional):

1. Krita › **Preferences…** › **Keyboard Shortcuts**.
2. In the search box type `brush editor`. Click the shortcut cell next to **Show Brush Editor**
   (it shows `F5`), then clear it (the small clear button, or choose **None**).
3. Do the same for **Show Brush Presets** (F6), **Properties…** under Layers (F3) and
   **Save Incremental Backup** (F4).
4. Click **OK**.

The brush editor is still one click away: the **Edit brush settings** button in the top toolbar.

## 6. Make Krita easy to use by dwelling (holding still over a button)

Krita's buttons are small (22–32 px). Steady lets you click by holding still over a button, which is
much easier on big targets. Voice commands ("brush", "blue", "bigger", "new layer") are the main way
to change tools; these steps make the remaining buttons bigger.

1. **Bigger tool icons.** Right-click an empty spot in the **Toolbox** (the column of tool icons on
   the left). Choose the **largest icon size** offered.
2. **Lock the dockers** so a dwell-click never drags a panel away: **Settings › Dockers ›
   Lock All Dockers** (the exact wording can differ slightly between versions; it is the lock item
   in that menu).
3. **Big colour swatches.** **Settings › Dockers › Palette** to show the Palette docker. Make the
   docker wide and tall; the swatches grow with it. Put your favourite colours in it. (Steady also
   understands colour names by voice: black, white, red, blue, green, yellow, orange, purple, brown,
   grey, plus "lighter" and "darker".)
4. **Eight brushes at most.** In the **Brush Presets** docker, make a tag called `Steady`
   (the tag drop-down at the top of the docker › add a new tag), right-click up to 8 brushes you like ›
   **Assign to tag** › `Steady`, then pick the `Steady` tag so only those 8 show. Fewer, bigger
   buttons are easier to hit.

## 7. Tapering strokes without pen pressure

A mouse (and so Steady) always presses "fully": brushes that get thinner with lighter pressure will
paint at full size and never taper. Two fixes; use either:

- **Make the brush taper with speed instead of pressure** (recommended):
  1. Choose the brush, then click **Edit brush settings** in the top toolbar.
  2. In the list on the left click **Size**.
  3. In the sensor list, untick **Pressure** and tick **Speed**. Drag the curve so it goes from
     high on the left to low on the right (faster = thinner). Optionally do the same for **Opacity**.
     **Fade** adds a taper at the start of each stroke.
  4. Click **Overwrite Brush** (or **Save New Brush Preset…** to keep the original).
- **Or pick a brush whose size does not depend on pressure**, for example a plain "Basic" brush.

Steady also changes size and opacity by voice: "bigger", "smaller", "size 20", "opacity 50",
"fade", "solid".

## 8. Hatching: keep the lines parallel

Steady's Hatch mode inks only the forward passes of a back-and-forth movement. Pair it with Krita's
**parallel ruler** so every line has the same angle:

1. In the Toolbox pick the **Assistant Tool** (the ruler-and-compass icon).
2. In the **Tool Options** docker choose **Parallel Ruler** as the assistant type.
3. Dwell-click two points on the canvas along the direction you want the hatching to run.
4. Switch back to the brush ("brush" by voice). In the brush's **Tool Options**, tick
   **Snap to Assistants** (labelled **Assistant** in some versions).
5. To stop snapping, untick it again.

## 9. Before every session (checklist)

- [ ] Tablet unplugged, Sidecar off.
- [ ] Krita open, a picture open (File › New, or open a file).
- [ ] Tools › Scripts › Steady: connection status says **helper connected**.
- [ ] The Chrome strip with Steady sits beside Krita, not behind it.

## Troubleshooting

| What you see | What to do |
|---|---|
| Steady says "Krita plugin off" | Krita is closed, the plugin is not ticked (step 4), or Krita was not restarted. Steady still works through keyboard shortcuts, but colours, presets, exact sizes and layers need the plugin. |
| "could not listen on 127.0.0.1:8766" | Another Krita is open, or another program uses that port. Quit all Krita windows and reopen one. |
| F5 or F6 still opens a Krita pop-up | Do section 5 by hand, then restart Krita. |
| The mouse is ignored in Krita | A tablet was connected when Krita started: unplug it and restart Krita. |
| You are on Krita 6 | The plugin loads, but it is only tested on Krita 5.3. Install 5.3 if anything misbehaves. |
