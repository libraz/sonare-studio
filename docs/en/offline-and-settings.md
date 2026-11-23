# Offline use and settings

The app installs as a web app and starts without a network. This page covers offline use, saving and named revisions, the English and Japanese interface, remapping shortcuts, and workspace layouts. The key tables are on [Keyboard shortcuts](shortcuts.md); headers and caching for hosting are on [Deployment](deployment.md).

## Work offline

The first visit installs a service worker that caches the whole release. One reload while online hands the page to the worker. From then on a reload with the network cut starts the app from the cache, with cross-origin isolation intact, and **Open the demo song** loads the demo with its notes.

The app ships a web app manifest that declares a standalone window with 192 and 512 pixel icons, so the browser can offer to install it.

## Save and continue

**File** > **Save** writes the project to the browser's storage, and the project header shows the time of the save. After a reload, **Continue last session** on the start screen restores the saved project with all its tracks.

The project also autosaves. Once an edit has gone unsaved for the **Autosave interval (seconds)** set in **Options** > **Settings…** > **General**, it is written to the browser, the header shows the time of the autosave, and the unsaved marker stays until **File** > **Save**. **Continue last session** after a reload restores the autosaved edit as well.

## Named revisions

1. Give the project a name with **File** > **Save As…**.
2. Open **File** > **Revisions…** and press **Save current state…**.
3. Enter a name in the **Save revision** prompt. The revision appears in the **Revisions** list.

To go back, edit the project, open **Revisions…** and press the revision's name. A prompt asks before discarding the current edits:

- **Cancel** keeps the edited project as it is.
- **Discard** loads the revision into the editor. The project shows as unsaved, and Undo and Redo start empty.

**File** > **Save** then stores the restored state, and reopening the named project from the start screen shows it.

## Switch the language

1. Open **Options** > **Settings…** and stay on the **General** tab.
2. Choose **English** or **Japanese** in **Language**.
3. Press `Esc` to close the dialog.

Menus, dock tabs and dialogs take the chosen language, and the page's `lang` attribute follows. The choice persists across reloads. Choosing the other language restores the previous labels.

## Remap a shortcut

1. Open **Options** > **Settings…** and select the **Shortcuts** tab.
2. Press **Change keys for** the action in its row, for example **Toggle score panel**.
3. Press the new key.

The key is added to the action's bindings and does not replace them. It works immediately, and it persists across reloads. **Reset keys for** the action clears the override and restores the default binding.

## Show the shortcut list

Press `?` to open the **Keyboard shortcuts** dialog and `Esc` to close it. Focus returns to the control that had it before the dialog opened.

## Workspace layouts

Open **Options** > **Settings…** and select the **Layouts** tab. Press **Apply** in a preset's row:

- **Mix** shows the **Mixer** tab and closes the device rack.
- **Compose** shows the **Piano Roll** tab and opens the device rack.
