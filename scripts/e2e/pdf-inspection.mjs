import { inflateSync } from 'node:zlib';

/**
 * Reads the font facts of a PDF: which fonts it declares, and which Unicode
 * code points the ToUnicode maps of its embedded fonts can produce. Streams are
 * inflated when they are Flate-compressed and read raw otherwise.
 *
 * @param {Buffer} bytes The PDF file.
 * @returns {{ baseFonts: string[], type0Fonts: number, cidFonts: number, fontFiles: number,
 *   mappedCodePoints: Set<number> }}
 */
export function inspectPdfFonts(bytes) {
  const latin = bytes.toString('latin1');
  const streams = [];
  for (const match of latin.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = bytes.subarray(start, end);
    try {
      streams.push(inflateSync(raw).toString('latin1'));
    } catch {
      streams.push(raw.toString('latin1'));
    }
  }
  const mappedCodePoints = new Set();
  for (const stream of streams) {
    for (const section of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const entry of section[1].matchAll(/<[0-9A-Fa-f]+>\s*<([0-9A-Fa-f]+)>/g)) {
        addUtf16(mappedCodePoints, entry[1]);
      }
    }
    for (const section of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const entry of section[1].matchAll(
        /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
      )) {
        const count = Number.parseInt(entry[2], 16) - Number.parseInt(entry[1], 16);
        const first = Number.parseInt(entry[3], 16);
        for (let offset = 0; offset <= count; offset++) mappedCodePoints.add(first + offset);
      }
    }
  }
  return {
    baseFonts: [...new Set([...latin.matchAll(/\/BaseFont\s*\/([^\s/<>[\]]+)/g)].map((m) => m[1]))],
    type0Fonts: (latin.match(/\/Subtype\s*\/Type0\b/g) ?? []).length,
    cidFonts: (latin.match(/\/Subtype\s*\/CIDFontType2\b/g) ?? []).length,
    fontFiles: (latin.match(/\/FontFile2\b/g) ?? []).length,
    mappedCodePoints,
  };
}

/** Adds the code points of one UTF-16BE hex string. */
function addUtf16(target, hex) {
  const units = [];
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    units.push(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  for (const character of String.fromCharCode(...units)) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) target.add(codePoint);
  }
}

/**
 * Reads what the page content streams draw: every shown text string with its
 * device-space origin and size (a string is its raw bytes, one char per byte),
 * and the device-space start point of every filled subpath. Tracks q/Q/cm and the text matrix; enough for svg2pdf output.
 *
 * @param {Buffer} bytes The PDF file.
 * @returns {{ texts: Array<{ text: string, x: number, y: number, size: number }>,
 *   fills: Array<{ x: number, y: number }> }}
 */
export function inspectPdfDrawing(bytes) {
  const latin = bytes.toString('latin1');
  const objects = new Map();
  // The dictionary may not run past its own object into the next one's stream.
  for (const match of latin.matchAll(/(\d+) 0 obj\s*<<((?:(?!endobj)[\s\S])*?)>>\s*stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    const raw = bytes.subarray(start, end);
    let content;
    try {
      content = inflateSync(raw).toString('latin1');
    } catch {
      content = raw.toString('latin1');
    }
    objects.set(Number(match[1]), content);
  }
  const texts = [];
  const fills = [];
  for (const ref of latin.matchAll(/\/Contents\s+(\d+) 0 R/g)) {
    const content = objects.get(Number(ref[1]));
    if (content !== undefined) interpretContent(content, texts, fills);
  }
  return { texts, fills };
}

const multiply = (a, b) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => ({ x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] });

function interpretContent(content, texts, fills) {
  const identity = [1, 0, 0, 1, 0, 0];
  let ctm = identity;
  const stack = [];
  let textMatrix = identity;
  let lineMatrix = identity;
  let fontSize = 0;
  let pending = [];
  const operands = [];
  for (const token of tokenize(content)) {
    if (token.kind !== 'op') {
      operands.push(token);
      continue;
    }
    const n = operands.map((operand) => operand.value);
    switch (token.value) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? identity;
        break;
      case 'cm':
        ctm = multiply(n.slice(-6), ctm);
        break;
      case 'BT':
        textMatrix = identity;
        lineMatrix = identity;
        break;
      case 'Tf':
        fontSize = n[n.length - 1];
        break;
      case 'Tm':
        textMatrix = n.slice(-6);
        lineMatrix = textMatrix;
        break;
      case 'Td':
        lineMatrix = multiply([1, 0, 0, 1, n[n.length - 2], n[n.length - 1]], lineMatrix);
        textMatrix = lineMatrix;
        break;
      case 'Tj':
      case 'TJ': {
        const strings = operands.filter((operand) => operand.kind === 'string');
        const shown = strings.map((operand) => operand.value).join('');
        const device = multiply(textMatrix, ctm);
        const origin = apply(device, 0, 0);
        texts.push({
          text: shown,
          ...origin,
          size: fontSize * Math.hypot(device[2], device[3]),
        });
        break;
      }
      case 'm':
        pending.push(apply(ctm, n[n.length - 2], n[n.length - 1]));
        break;
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        fills.push(...pending);
        pending = [];
        break;
      case 'n':
      case 'S':
      case 's':
        pending = [];
        break;
      default:
        break;
    }
    operands.length = 0;
  }
}

/** Splits a content stream into numbers, strings, names, array brackets and operators. */
function* tokenize(content) {
  let index = 0;
  while (index < content.length) {
    const character = content[index];
    if (/\s/.test(character)) {
      index++;
    } else if (character === '%') {
      while (index < content.length && content[index] !== '\n') index++;
    } else if (character === '(') {
      let depth = 1;
      let value = '';
      index++;
      while (index < content.length && depth > 0) {
        const next = content[index++];
        if (next === '\\') {
          const escaped = content[index++];
          const named = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[escaped];
          if (named !== undefined) value += named;
          else if (/[0-7]/.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && /[0-7]/.test(content[index])) octal += content[index++];
            value += String.fromCharCode(Number.parseInt(octal, 8));
          } else if (escaped !== '\n') value += escaped;
        } else if (next === '(') {
          depth++;
          value += next;
        } else if (next === ')') {
          depth--;
          if (depth > 0) value += next;
        } else value += next;
      }
      yield { kind: 'string', value };
    } else if (character === '<' && content[index + 1] !== '<') {
      const end = content.indexOf('>', index);
      const hex = content.slice(index + 1, end).replace(/\s/g, '');
      let value = '';
      for (let at = 0; at < hex.length; at += 2) {
        value += String.fromCharCode(Number.parseInt(hex.slice(at, at + 2).padEnd(2, '0'), 16));
      }
      yield { kind: 'string', value };
      index = end + 1;
    } else if (content.startsWith('<<', index) || content.startsWith('>>', index)) {
      yield { kind: 'bracket', value: content.slice(index, index + 2) };
      index += 2;
    } else if ('[]'.includes(character)) {
      yield { kind: 'bracket', value: character };
      index++;
    } else if (character === '/') {
      const match = /^\/[^\s/<>[\]()%]*/.exec(content.slice(index, index + 128));
      yield { kind: 'name', value: match[0] };
      index += match[0].length;
    } else {
      const match = /^[^\s/<>[\]()%]+/.exec(content.slice(index, index + 64));
      const word = match[0];
      index += word.length;
      const number = Number(word);
      yield Number.isNaN(number) || word === ''
        ? { kind: 'op', value: word }
        : { kind: 'number', value: number };
    }
  }
}
