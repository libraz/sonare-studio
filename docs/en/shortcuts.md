# Keyboard shortcuts

`Mod` is `Cmd` on macOS and `Ctrl` elsewhere. Shortcuts are ignored while an
input, textarea, select or contenteditable element has focus.

> **Registry source:** the customizable shortcuts below are declared in the
> registry at [`src/ui/settings/shortcuts.ts`](../../src/ui/settings/shortcuts.ts)
> (`SHORTCUT_ACTIONS`); user overrides replace an action's default keys per
> action. When you add or change an action there, update this table.

## Transport

| Keys | Action | Scope |
| --- | --- | --- |
| `Space` | Play / Stop <!-- shortcut-action: transport.togglePlayback --> | global |
| `L` | Toggle loop between the left and right locators <!-- shortcut-action: transport.toggleLoop --> | global |
| `R` | Record <!-- shortcut-action: transport.toggleRecord --> | global |
| `Home` | Go to project start <!-- shortcut-action: transport.toStart --> | global |
| `End` | Go to project end <!-- shortcut-action: transport.toEnd --> | global |
| `,` / `.` | Nudge playhead back / forward one bar <!-- shortcut-action: transport.nudgeBack --> <!-- shortcut-action: transport.nudgeForward --> | global |
| `[` / `]` | Set left / right locator at the playhead <!-- shortcut-action: transport.setLeftLocator --> <!-- shortcut-action: transport.setRightLocator --> | global |

## Project

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+S` | Save project (OPFS; also refreshes the autosave slot) <!-- shortcut-action: project.save --> | global |
| `Mod+Shift+S` | Save project as… <!-- shortcut-action: project.saveAs --> | global |
| `Mod+O` | Open project <!-- shortcut-action: project.open --> | global |

## Editing

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+Z` | Undo <!-- shortcut-action: edit.undo --> | global |
| `Mod+Shift+Z` | Redo <!-- shortcut-action: edit.redo --> | global |
| `Mod+C` | Copy the current selection <!-- shortcut-action: edit.copy --> | global |
| `Mod+X` | Cut the current selection <!-- shortcut-action: edit.cut --> | global |
| `Mod+V` | Paste at the playhead <!-- shortcut-action: edit.paste --> | global |
| `Mod+A` | Select all notes in the active clip <!-- shortcut-action: edit.selectAllNotes --> | global |
| `Q` | Quantize selected notes <!-- shortcut-action: edit.quantizeSelection --> | global |
| `Backspace` / `Delete` | Delete selected notes <!-- shortcut-action: edit.deleteSelectedNotes --> | editor dock |
| `Shift+ArrowUp` / `Shift+ArrowDown` | Transpose selected notes up / down a semitone <!-- shortcut-action: edit.transposeUp --> <!-- shortcut-action: edit.transposeDown --> | editor dock |
| `Mod+Shift+ArrowUp` / `Mod+Shift+ArrowDown` | Transpose selected notes up / down an octave <!-- shortcut-action: edit.transposeOctaveUp --> <!-- shortcut-action: edit.transposeOctaveDown --> | editor dock |
| `Escape` | Cancel an in-flight drag gesture (piano roll) | editor dock |
| `[` / `]` | Shorten / lengthen selected notes by one grid step (piano roll). Overrides the global locator shortcuts while notes are selected in the focused piano roll | editor dock |

## Arrangement

These fire when the arrangement zone has focus (last pointer-down).

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+D` | Duplicate the active clip right after itself <!-- shortcut-action: arrange.duplicateClip --> | arrangement |
| `B` | Split clip at the playhead <!-- shortcut-action: arrange.splitClipAtPlayhead --> | arrangement |
| `Backspace` / `Delete` | Delete the active clip <!-- shortcut-action: arrange.deleteClip --> | arrangement |

## Track

These act on the active arrangement track.

| Keys | Action | Scope |
| --- | --- | --- |
| `Alt+M` | Toggle active track mute <!-- shortcut-action: track.toggleMute --> | arrangement |
| `Alt+S` | Toggle active track solo <!-- shortcut-action: track.toggleSolo --> | arrangement |
| `Alt+A` | Toggle active track record arm <!-- shortcut-action: track.toggleArm --> | arrangement |

## View

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+G` | Toggle snap grid <!-- shortcut-action: view.toggleSnap --> | global |
| `Mod+E` | Toggle the score panel (switches the dock to the piano roll) <!-- shortcut-action: view.toggleScorePanel --> | global |
| `Mod+=` | Zoom in <!-- shortcut-action: view.zoomIn --> | global |
| `Mod+-` | Zoom out <!-- shortcut-action: view.zoomOut --> | global |
| `Mod+Shift+F` | Zoom to fit <!-- shortcut-action: view.zoomToFit --> | global |

## Score

These apply while the score panel has focus. Each edit is an undoable command on the active clip.

| Keys | Action | Scope |
| --- | --- | --- |
| `N` | Add a note after the selected note, same pitch and length | score |
| Double-click | Insert a note at the clicked position (copies the selected note, or middle C) | score |
| Vertical drag on a note | Change its pitch by one semitone per drag step | score |
| `Backspace` / `Delete` | Delete selected notes (editor dock shortcut) | editor dock |

## Tools

| Keys | Action | Scope |
| --- | --- | --- |
| `1` | Select tool <!-- shortcut-action: tool.select --> | global |
| `2` | Draw tool <!-- shortcut-action: tool.draw --> | global |
| `3` | Split tool <!-- shortcut-action: tool.split --> | global |
| `4` | Erase tool <!-- shortcut-action: tool.erase --> | global |

## Application

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+,` | Open settings <!-- shortcut-action: app.settings --> | global |
| `Mod+K` | Open command palette <!-- shortcut-action: app.commandPalette --> | global |
| `?` | Show shortcut help <!-- shortcut-action: help.shortcuts --> | global |

## Music typing (fixed, not remappable)

Active while "Music typing" is enabled in the editor toolbar; window-level,
released on blur.

| Keys | Action |
| --- | --- |
| `A W S E D F T G Y H U J K` | Play notes (C and up from the base octave, white/black keys interleaved) |
| `Z` / `X` | Octave down / up (clamped −1..9) |
| `C` / `V` | Velocity −10 / +10 (clamped 1..127) |
| `Tab` | Insert a rest (only while step input is armed) |

## Pointer gestures

| Gesture | Action | Where |
| --- | --- | --- |
| `Mod+wheel` | Zoom | arrangement, piano roll |
| `Shift+wheel` | Horizontal scroll | arrangement, piano roll |
| Wheel | Pan | arrangement, piano roll |
| Double-click | Create a note / clip | piano roll / arrangement lane |

## Dialogs and widgets

| Keys | Action | Where |
| --- | --- | --- |
| `Escape` | Close / cancel | New project, Export audio, Patch editor dialogs; welcome tour |
| `Enter` | Confirm / create | New project dialog; inline rename and value fields |
| `ArrowUp` / `ArrowDown` | Move template selection | New project dialog |
| `Escape` while rendering | Cancel the export render | Export audio dialog |
| `ArrowUp/Right` / `ArrowDown/Left` | Increment / decrement (hold `Shift` for fine steps where supported) | Mixer faders, knobs, quick controls |
| `Enter` / `Escape` | Commit / revert a cell | Tempo map, time signature, info line editors |
| `Enter` / `Escape` | Commit / cancel rename | Section lane, track headers |
| `Enter` / `ArrowRight`, `ArrowLeft`, `Escape` | Next, back, skip | Welcome tour tooltip |
