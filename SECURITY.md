# Security policy

## Reporting a vulnerability

Use **Report a vulnerability** on the repository’s [Security tab](https://github.com/libraz/sonare-studio/security) to report privately. Keep vulnerability details out of public issues.

Include the project or file that triggers it, the steps, what happened, the commit or deployed version, the browser, and a minimal reproduction if you have one. Expect an acknowledgement within a few days.

## Supported versions

Pre-1.0. Fixes land on `main` and the deployed app only; older commits are not patched.

## What is in scope

sonare studio opens files it did not write (`.szd` projects, browser backups, DAWproject, Standard MIDI File, MIDI 2.0 clips, MusicXML, SoundFonts and audio) and runs entirely in the user's browser. In scope:

- A file whose content runs as script in the app's page: track, clip, marker or preset names, score text, metadata or any other file content reaching the DOM as markup.
- A crafted archive or file that writes outside the project or asset it belongs to in the browser's origin-private storage, or overwrites another project, revision or backup.
- A crafted file that makes the app hang, exhaust memory, or keep growing storage without bound, where the importer's own size and memory limits should have refused it.
- Anything that sends project content, audio or files off the device. The app makes no uploads by design.
- A way around the cross-origin isolation the app is served with, or a service-worker cache that can be made to serve content from another origin.

## What is not in scope

- DSP, analysis or rendering defects inside the audio engine, including crashes in its WebAssembly. Report those to the [libsonare](https://github.com/libraz/libsonare) project, which has its own security policy.
- Data loss from clearing browser storage or from the browser evicting it.
- Findings that require an attacker to already control the page, the browser profile or the server hosting the app.
