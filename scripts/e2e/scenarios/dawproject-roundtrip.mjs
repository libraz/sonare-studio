import { untilDoneAcceptingConfirms, unzipSync } from '../harness.mjs';

/** Export a mixed MIDI/audio project and import the actual archive again. */
export const name = 'dawproject-roundtrip';

function decodeXmlEntities(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXmlEntities(match[1]) : null;
}

function numberAttribute(tag, name) {
  const value = Number(attribute(tag, name));
  return Number.isFinite(value) ? value : null;
}

function rounded(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function elementBody(xml, name) {
  const open = xml.indexOf(`<${name}`);
  if (open < 0) return '';
  const openEnd = xml.indexOf('>', open);
  const close = xml.indexOf(`</${name}>`, openEnd + 1);
  return openEnd < 0 || close < 0 ? '' : xml.slice(openEnd + 1, close);
}

function parseNotes(clipBody) {
  return [...clipBody.matchAll(/<Note\b[^>]*\/>/g)]
    .map(([tag]) => ({
      channel: Number(attribute(tag, 'channel')),
      pitch: Number(attribute(tag, 'key')),
      startPpq: rounded(Number(attribute(tag, 'time'))),
      durationPpq: rounded(Number(attribute(tag, 'duration'))),
    }))
    .filter(
      (note) =>
        Number.isInteger(note.channel) &&
        Number.isInteger(note.pitch) &&
        Number.isFinite(note.startPpq) &&
        Number.isFinite(note.durationPpq),
    );
}

function parseClip(openTag, body) {
  const notes = parseNotes(body);
  const audioTag = body.match(/<Audio\b[^>]*>/)?.[0] ?? null;
  const fileTag = body.match(/<File\b[^>]*\/>/)?.[0] ?? null;
  return {
    kind: notes.length > 0 || body.includes('<Notes') ? 'midi' : audioTag ? 'audio' : 'unknown',
    startPpq: rounded(numberAttribute(openTag, 'time') ?? 0),
    lengthPpq: rounded(numberAttribute(openTag, 'duration') ?? 0),
    playStart: rounded(numberAttribute(openTag, 'playStart') ?? 0),
    fadeIn: rounded(numberAttribute(openTag, 'fadeInTime') ?? 0),
    fadeOut: rounded(numberAttribute(openTag, 'fadeOutTime') ?? 0),
    notes,
    audioPath: fileTag ? attribute(fileTag, 'path') : null,
    audioDurationSec: audioTag ? rounded(numberAttribute(audioTag, 'duration') ?? 0) : null,
  };
}

function parseClips(clipsBody) {
  const clips = [];
  for (const match of clipsBody.matchAll(/(<Clip\b[^>]*>)([\s\S]*?)<\/Clip>/g)) {
    clips.push(parseClip(match[1], match[2]));
  }
  for (const match of clipsBody.matchAll(/<Clip\b[^>]*\/>/g)) {
    clips.push(parseClip(match[0], ''));
  }
  return clips.sort(
    (a, b) => a.startPpq - b.startPpq || a.lengthPpq - b.lengthPpq || a.kind.localeCompare(b.kind),
  );
}

function parseArchiveSemantics(bytes) {
  const entries = unzipSync(bytes);
  const projectXml = new TextDecoder().decode(entries['project.xml'] ?? new Uint8Array());
  if (!projectXml.includes('<Project'))
    throw new Error('DAWproject archive is missing project.xml');

  const arrangement = elementBody(projectXml, 'Arrangement');
  const lanesByTrack = new Map();
  for (const match of arrangement.matchAll(
    /(<Lanes\b(?=[^>]*\btrack=)[^>]*>)([\s\S]*?)<\/Lanes>/g,
  )) {
    const trackId = attribute(match[1], 'track');
    if (!trackId) continue;
    const clipsBody = elementBody(match[2], 'Clips');
    lanesByTrack.set(trackId, parseClips(clipsBody));
  }

  const structure = elementBody(projectXml, 'Structure');
  const tracks = [];
  for (const match of structure.matchAll(/<Track\b[^>]*>/g)) {
    const tag = match[0];
    const id = attribute(tag, 'id');
    if (!id || id === 'master-track') continue;
    const contentType = attribute(tag, 'contentType');
    const kind = contentType === 'notes' ? 'midi' : contentType === 'audio' ? 'audio' : 'group';
    tracks.push({
      kind,
      name: attribute(tag, 'name') ?? '',
      clips: lanesByTrack.get(id) ?? [],
    });
  }

  const audioEntries = Object.entries(entries)
    .filter(([name]) => name.startsWith('audio/') && name.toLowerCase().endsWith('.wav'))
    .map(([name, payload]) => ({
      name,
      byteLength: payload.byteLength,
      nonZeroPayload: payload.slice(44).some((byte) => byte !== 0),
      riff: String.fromCharCode(...payload.slice(0, 4)) === 'RIFF',
      wave: String.fromCharCode(...payload.slice(8, 12)) === 'WAVE',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let extension = null;
  const extensionBytes = entries['sonare-studio.json'];
  if (extensionBytes) {
    try {
      extension = JSON.parse(new TextDecoder().decode(extensionBytes));
    } catch {
      extension = null;
    }
  }

  return { entries, projectXml, tracks, audioEntries, extension };
}

async function downloadBytes(page) {
  return page.evaluate(async () => {
    const download = window.__sonareDebug.lastDownload();
    if (!download) throw new Error('DAWproject export did not produce a download');
    const bytes = new Uint8Array(await download.blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return { filename: download.filename, base64: btoa(binary) };
  });
}

function bytesFromBase64(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function archiveSignature(archive) {
  const audioPaths = new Map();
  for (const track of archive.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'audio' && clip.audioPath && !audioPaths.has(clip.audioPath)) {
        audioPaths.set(clip.audioPath, audioPaths.size);
      }
    }
  }
  return archive.tracks.map((track) => ({
    kind: track.kind,
    name: track.name,
    clips: track.clips.map((clip) => ({
      kind: clip.kind,
      startPpq: clip.startPpq,
      lengthPpq: clip.lengthPpq,
      playStart: clip.playStart,
      fadeIn: clip.fadeIn,
      fadeOut: clip.fadeOut,
      audioAsset: clip.kind === 'audio' ? (audioPaths.get(clip.audioPath) ?? -1) : null,
      notes: {
        count: clip.notes.length,
        channels: clip.notes.map((note) => note.channel).sort((a, b) => a - b),
        events: clip.notes
          .map((note) => [note.pitch, note.channel, note.startPpq, note.durationPpq])
          .sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1] || a[3] - b[3]),
      },
    })),
  }));
}

function missingAudioReferences(archive) {
  const entries = new Set(archive.audioEntries.map((entry) => entry.name));
  return archive.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.kind === 'audio' && !entries.has(clip.audioPath))
      .map((clip) => `${track.name}: ${clip.audioPath ?? '(missing path)'}`),
  );
}

function portableChordRanges(extension) {
  if (!extension || typeof extension !== 'object') return null;
  const candidate = extension.chords ?? extension.chordRanges;
  if (!Array.isArray(candidate)) return null;
  return candidate
    .map((chord) => ({
      startPpq: rounded(Number(chord.startPpq)),
      endPpq: rounded(Number(chord.endPpq)),
      rootPc: Number(chord.rootPc),
      quality: String(chord.quality ?? ''),
    }))
    .filter(
      (chord) =>
        Number.isFinite(chord.startPpq) &&
        Number.isFinite(chord.endPpq) &&
        Number.isInteger(chord.rootPc) &&
        chord.quality.length > 0,
    );
}

async function installDownloadCounter(page) {
  return page.evaluate(() => {
    const win = window;
    if (!win.__sonareE2eDownloadCounterInstalled) {
      win.__sonareE2eDownloadCount = 0;
      document.addEventListener(
        'click',
        (event) => {
          const target = event.target;
          const anchor = target instanceof Element ? target.closest('a[download]') : null;
          if (anchor) win.__sonareE2eDownloadCount += 1;
        },
        true,
      );
      win.__sonareE2eDownloadCounterInstalled = true;
    }
    return win.__sonareE2eDownloadCount ?? 0;
  });
}

async function exportDawproject(page) {
  const previousDownloads = await installDownloadCounter(page);
  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Export DAWproject$/ })
    .click();
  await untilDoneAcceptingConfirms(
    page,
    () =>
      page.evaluate(
        (previous) => (window.__sonareE2eDownloadCount ?? 0) > previous,
        previousDownloads,
      ),
    60000,
  );
  const download = await downloadBytes(page);
  if (!download.filename.toLowerCase().endsWith('.dawproject')) {
    throw new Error(`unexpected DAWproject filename: ${download.filename}`);
  }
  return bytesFromBase64(download.base64);
}

async function acceptDiscardPrompt(page) {
  const modal = page.locator('.modal-card:has(.dialog-message)');
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    return;
  }
  const buttons = modal.locator('button');
  if ((await buttons.count()) === 0) throw new Error('discard dialog has no action button');
  await buttons.last().click();
  await modal.waitFor({ state: 'detached', timeout: 10000 });
}

async function importDawproject(page, bytes, expected) {
  // Chromium exposes showOpenFilePicker in headed mode. Remove that optional
  // path for this test so Playwright drives the same real input file chooser
  // a user gets in browsers without the File System Access API.
  await page.evaluate(() => {
    try {
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true,
        value: undefined,
      });
    } catch {
      // The fallback input may already be the only available picker.
    }
  });
  const chooserPromise = page.waitForEvent('filechooser');
  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Import DAWproject/ })
    .click();
  await acceptDiscardPrompt(page);
  const chooser = await chooserPromise;
  const dirtyBefore = await page.locator('.project-name .dirty-dot').count();
  await chooser.setFiles({
    name: 'sonare-roundtrip.dawproject',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
  if (dirtyBefore > 0) {
    await page.locator('.project-name .dirty-dot').waitFor({ state: 'detached', timeout: 30000 });
  }
  try {
    await page.waitForFunction(
      ({ tracks, clips, audioClips, expectedRanges }) => {
        const debug = window.__sonareDebug;
        return (
          debug?.initialized() === true &&
          debug.trackCount() === tracks &&
          debug.clipCount() === clips &&
          debug.audioClipCount() === audioClips &&
          JSON.stringify(
            debug
              .clipRanges()
              .map(({ kind, startPpq, lengthPpq }) => ({ kind, startPpq, lengthPpq }))
              .sort(
                (a, b) =>
                  a.startPpq - b.startPpq ||
                  a.lengthPpq - b.lengthPpq ||
                  a.kind.localeCompare(b.kind),
              ),
          ) === JSON.stringify(expectedRanges) &&
          !document.querySelector('.modal-card:has(.dialog-message)')
        );
      },
      expected,
      { timeout: 30000 },
    );
  } catch (cause) {
    const actual = await page.evaluate(() => ({
      initialized: window.__sonareDebug?.initialized(),
      tracks: window.__sonareDebug?.trackCount(),
      clips: window.__sonareDebug?.clipCount(),
      audioClips: window.__sonareDebug?.audioClipCount(),
      ranges: window.__sonareDebug?.clipRanges(),
      alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
      dialogs: [...document.querySelectorAll('.modal-card')].map((node) =>
        node.textContent?.slice(0, 500),
      ),
    }));
    throw new Error(`DAWproject import state differs: ${JSON.stringify({ expected, actual })}`, {
      cause,
    });
  }
}

async function shortExportProbe(page) {
  return page.evaluate(async () => {
    if (typeof window.__sonareDebug.exportProbe !== 'function') return null;
    return window.__sonareDebug.exportProbe(false, { startPpq: 0, endPpq: 8 }, true);
  });
}

async function openFreshShell(page, baseUrl) {
  await page.context().addInitScript(() => {
    try {
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true,
        value: undefined,
      });
    } catch {
      // The browser may already omit the File System Access API.
    }
  });
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.locator('[data-testid="start-demo"]').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('[data-testid="start-demo"]').click();
  await page.waitForFunction(() => window.__sonareDebug?.initialized() === true, null, {
    timeout: 30000,
  });
  const tour = page.locator('.tour-tooltip');
  try {
    await tour.waitFor({ state: 'visible', timeout: 10000 });
    await tour.locator('.tour-skip').click();
    await page.locator('.tour-overlay').waitFor({ state: 'detached', timeout: 5000 });
  } catch {
    // The shared browser profile may already have dismissed the first-run tour.
  }
}

export async function run({ page, baseUrl, fail }) {
  const beforeChordDebug = await page.evaluate(() => window.__sonareDebug.chordRanges());
  const sourceState = await page.evaluate(() => ({
    tracks: window.__sonareDebug.trackCount(),
    clips: window.__sonareDebug.clipCount(),
    audioClips: window.__sonareDebug.audioClipCount(),
    ranges: window.__sonareDebug.clipRanges().map(({ kind, startPpq, lengthPpq }) => ({
      kind,
      startPpq,
      lengthPpq,
    })),
  }));
  const beforeBytes = await exportDawproject(page);
  const before = parseArchiveSemantics(beforeBytes);
  const archiveClipCount = before.tracks.reduce((sum, track) => sum + track.clips.length, 0);
  if (before.tracks.length !== sourceState.tracks || archiveClipCount !== sourceState.clips) {
    fail(
      `DAWproject archive omitted tracks or clips: ${JSON.stringify({ sourceState, archiveTracks: before.tracks.length, archiveClipCount })}`,
    );
  }
  const expected = {
    tracks: sourceState.tracks,
    clips: sourceState.clips,
    audioClips: sourceState.audioClips,
    expectedRanges: sourceState.ranges.sort(
      (a, b) =>
        a.startPpq - b.startPpq || a.lengthPpq - b.lengthPpq || a.kind.localeCompare(b.kind),
    ),
  };

  if (before.audioEntries.length !== 2) {
    fail(`expected two embedded audio assets before round-trip, got ${before.audioEntries.length}`);
  }
  if (before.audioEntries.some((asset) => !asset.riff || !asset.wave || !asset.nonZeroPayload)) {
    fail(
      `audio archive entries do not contain waveform payloads: ${JSON.stringify(before.audioEntries)}`,
    );
  }
  if (missingAudioReferences(before).length > 0) {
    fail(
      `DAWproject export has unresolved audio references: ${missingAudioReferences(before).join(', ')}`,
    );
  }
  if (!before.tracks.some((track) => track.kind === 'midi')) {
    fail(`DAWproject export has no MIDI tracks: ${JSON.stringify(before.tracks)}`);
  }
  const beforeNotes = before.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.notes));
  if (!beforeNotes.some((note) => note.channel === 9)) {
    fail('DAWproject fixture has no channel-9 drum notes to round-trip');
  }

  const browser = page.context().browser();
  if (!browser) throw new Error('Playwright browser is unavailable for the isolated round-trip');
  const roundtripContext = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  const roundtripPage = await roundtripContext.newPage();
  try {
    await openFreshShell(roundtripPage, baseUrl);
    await importDawproject(roundtripPage, beforeBytes, expected);
    const importedChords = await roundtripPage.evaluate(() => window.__sonareDebug.chordRanges());
    if (JSON.stringify(importedChords) !== JSON.stringify(beforeChordDebug)) {
      fail(
        `DAWproject import changed chord guidance: ${JSON.stringify({ before: beforeChordDebug, after: importedChords })}`,
      );
    }
    const afterBytes = await exportDawproject(roundtripPage);
    const after = parseArchiveSemantics(afterBytes);

    const beforeSignature = archiveSignature(before);
    const afterSignature = archiveSignature(after);
    if (JSON.stringify(afterSignature) !== JSON.stringify(beforeSignature)) {
      fail(
        `DAWproject track/clip/note semantics changed on round-trip: ${JSON.stringify({ before: beforeSignature, after: afterSignature })}`,
      );
    } else {
      console.info(
        `DAWproject round-trip preserved ${after.tracks.length} tracks and ${afterNotes(after).length} MIDI notes including drums`,
      );
    }

    if (after.audioEntries.length !== 2) {
      fail(`DAWproject round-trip lost audio assets: ${after.audioEntries.length}`);
    }
    if (after.audioEntries.some((asset) => !asset.riff || !asset.wave || !asset.nonZeroPayload)) {
      fail(`round-tripped audio lacks waveform payloads: ${JSON.stringify(after.audioEntries)}`);
    }
    if (missingAudioReferences(after).length > 0) {
      fail(
        `round-tripped clips reference missing audio: ${missingAudioReferences(after).join(', ')}`,
      );
    }
    const afterNotesList = afterNotes(after);
    if (!afterNotesList.some((note) => note.channel === 9)) {
      fail('round-tripped DAWproject lost channel-9 drum notes');
    }
    if (afterNotesList.length !== beforeNotes.length) {
      fail(
        `round-tripped MIDI note count changed: ${beforeNotes.length} -> ${afterNotesList.length}`,
      );
    }

    const beforePortableChords = portableChordRanges(before.extension);
    const afterPortableChords = portableChordRanges(after.extension);
    if (beforePortableChords !== null) {
      if (JSON.stringify(afterPortableChords) !== JSON.stringify(beforePortableChords)) {
        fail(
          `portable chord ranges changed on round-trip: ${JSON.stringify({ before: beforePortableChords, after: afterPortableChords })}`,
        );
      }
    } else {
      const afterChordDebug = await roundtripPage.evaluate(() =>
        window.__sonareDebug.chordRanges(),
      );
      if (beforeChordDebug.length > 0 && afterChordDebug.length === 0) {
        console.info(
          `DAWproject chord ranges skipped: current format has no chord extension (${beforeChordDebug.length} source ranges)`,
        );
      } else {
        console.info(`DAWproject chord ranges are not part of the current portable archive`);
      }
    }

    try {
      const probe = await shortExportProbe(roundtripPage);
      if (
        probe === null ||
        probe.riff !== 'RIFF' ||
        probe.wavBytes <= 44 ||
        probe.totalFrames <= 0
      ) {
        fail(`short post-import export probe is invalid: ${JSON.stringify(probe)}`);
      } else {
        const audioStems = (probe.stems ?? []).filter((stem) => stem.trackIndex >= 4);
        if (audioStems.length !== 2 || audioStems.some((stem) => stem.peakDb < -70)) {
          fail(`post-import audio track stems are silent: ${JSON.stringify(audioStems)}`);
        }
        console.info(
          `post-import audio probe: ${probe.totalFrames} frames, ${probe.wavBytes} WAV bytes, peak ${probe.peakDb} dB`,
        );
      }
    } catch (error) {
      fail(
        `short post-import export probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    await roundtripContext.close();
  }
}

function afterNotes(archive) {
  return archive.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.notes));
}
