# Keyboard shortcuts

`Mod` is `Cmd` on macOS and `Ctrl` elsewhere. Shortcuts are ignored while an
input, textarea, select or contenteditable element has focus.

> **Keep in sync:** the customizable shortcuts below are declared in the
> registry at [`src/ui/settings/shortcuts.ts`](../src/ui/settings/shortcuts.ts)
> (`SHORTCUT_ACTIONS`); user overrides replace an action's default keys per
> action. When you add or change an action there, update this table.

## Transport

| Keys | Action | Scope |
| --- | --- | --- |
| `Space` | Play / Stop | global |
| `L` | Toggle loop (whole project range) | global |

## Project

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+S` | Save project (OPFS; also refreshes the autosave slot) | global |

## Editing

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+Z` | Undo | global |
| `Mod+Shift+Z` | Redo | global |
| `Mod+A` | Select all notes in the active clip | global |
| `Q` | Quantize selected notes | global |
| `Backspace` / `Delete` | Delete selected notes | editor dock |
| `Escape` | Cancel an in-flight drag gesture (piano roll) | editor dock |

## Arrangement

These fire when the arrangement zone has focus (last pointer-down).

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+D` | Duplicate the active clip right after itself | arrangement |
| `B` | Split clip at the playhead | arrangement |
| `Backspace` / `Delete` | Delete the active clip (falls back to deleting selected notes when no clip is active) | arrangement |

## View

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+G` | Toggle snap grid | global |
| `Mod+E` | Toggle the score panel (switches the dock to the piano roll) | global |

## Application

| Keys | Action | Scope |
| --- | --- | --- |
| `Mod+,` | Open settings | global |
| `?` | Show shortcut help | global |

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
