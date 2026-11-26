/**
 * Generate the small SoundFont used by the SoundFont end-to-end scenarios.
 * The sample is a synthetic 1 kHz sine wave at 32 kHz with eight zero samples
 * of padding. The generator takes no external audio input.
 *
 * Run with `node scripts/e2e/fixtures/generate-minimal-gs.mjs` to write the
 * SoundFont bytes to stdout.
 */

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function chunk(id, contents) {
  return Buffer.concat([Buffer.from(id, 'ascii'), uint32(contents.length), contents]);
}

function list(type, chunks) {
  return chunk('LIST', Buffer.concat([Buffer.from(type, 'ascii'), ...chunks]));
}

function fixedName(name, width = 20) {
  const bytes = Buffer.from(name, 'ascii');
  if (bytes.length > width) throw new RangeError(`SoundFont name is too long: ${name}`);
  return Buffer.concat([bytes, Buffer.alloc(width - bytes.length)]);
}

function presetHeader(name, preset, bank, bagIndex) {
  return Buffer.concat([
    fixedName(name),
    uint16(preset),
    uint16(bank),
    uint16(bagIndex),
    uint32(0), // Library
    uint32(0), // Genre
    uint32(0), // Morphology
  ]);
}

function bag(generatorIndex, modulatorIndex = 0) {
  return Buffer.concat([uint16(generatorIndex), uint16(modulatorIndex)]);
}

function generator(operator, amount) {
  return Buffer.concat([uint16(operator), uint16(amount)]);
}

function instrumentHeader(name, bagIndex) {
  return Buffer.concat([fixedName(name), uint16(bagIndex)]);
}

function sampleHeader(name, start, end, loopStart, loopEnd, sampleRate, pitch, sampleType) {
  return Buffer.concat([
    fixedName(name),
    uint32(start),
    uint32(end),
    uint32(loopStart),
    uint32(loopEnd),
    uint32(sampleRate),
    Buffer.from([pitch, 0]), // Original pitch and pitch correction
    uint16(0), // Sample link
    uint16(sampleType),
  ]);
}

function sampleData() {
  const samples = Buffer.alloc(104 * 2);
  for (let index = 0; index < 96; index += 1) {
    const phase = (index % 32) / 32;
    samples.writeInt16LE(Math.trunc(29490 * Math.sin(2 * Math.PI * phase)), index * 2);
  }
  return samples;
}

const information = list('INFO', [
  chunk('ifil', Buffer.concat([uint16(2), uint16(4)])),
  chunk('INAM', Buffer.from('sonare test fixture\0', 'ascii')),
]);

const sampleDataList = list('sdta', [chunk('smpl', sampleData())]);

const presetHeaders = [
  presetHeader('Piano 1', 0, 0, 0),
  presetHeader('Piano 2', 1, 0, 1),
  presetHeader('Standard Kit', 0, 128, 2),
  presetHeader('EOP', 0, 0, 3),
];

const instrumentHeaders = [instrumentHeader('melodic', 0), instrumentHeader('EOI', 1)];

const sampleHeaders = [
  sampleHeader('sine1k', 0, 96, 32, 96, 32000, 60, 1),
  sampleHeader('EOS', 0, 0, 0, 0, 0, 0, 0),
];

const presetData = list('pdta', [
  chunk('phdr', Buffer.concat(presetHeaders)),
  chunk('pbag', Buffer.concat([bag(0), bag(1), bag(2), bag(3)])),
  chunk('pmod', Buffer.alloc(0)),
  chunk('pgen', Buffer.concat([generator(41, 0), generator(41, 0), generator(41, 0)])),
  chunk('inst', Buffer.concat(instrumentHeaders)),
  chunk('ibag', Buffer.concat([bag(0), bag(2)])),
  chunk('imod', Buffer.alloc(0)),
  chunk('igen', Buffer.concat([generator(54, 1), generator(53, 0)])),
  chunk('shdr', Buffer.concat(sampleHeaders)),
]);

const soundFont = chunk(
  'RIFF',
  Buffer.concat([Buffer.from('sfbk', 'ascii'), information, sampleDataList, presetData]),
);

process.stdout.write(soundFont);
