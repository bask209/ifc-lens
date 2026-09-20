// SPDX-License-Identifier: Apache-2.0
/**
 * Decoder for ISO 10303-21 string literals. Handles doubled apostrophes,
 * `\\`, `\S\` (upper-half characters in the active code page), `\P?\` code
 * page switches, `\X\hh`, `\X2\...\X0\` (UCS-2/UTF-16) and `\X4\...\X0\`
 * (UCS-4). Raw bytes above 0x7F (not legal STEP, but widespread) are decoded
 * as UTF-8 when valid and as ISO 8859-1 otherwise.
 */

export interface StringDiagnosticSink {
  (message: string): void;
}

const BACKSLASH = 0x5c;
const QUOTE = 0x27;

const pageDecoders = new Map<string, TextDecoder | null>();

function pageDecoder(page: string): TextDecoder | null {
  let d = pageDecoders.get(page);
  if (d === undefined) {
    // \PA\ = ISO 8859-1 ... \PI\ = ISO 8859-9
    const index = page.charCodeAt(0) - 0x40;
    try {
      d = index === 1 ? null : new TextDecoder(`iso-8859-${index}`);
    } catch {
      d = null;
    }
    pageDecoders.set(page, d);
  }
  return d;
}

let utf8: TextDecoder | undefined;

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function readHex(bytes: Uint8Array, at: number, digits: number, end: number): number {
  if (at + digits > end) return -1;
  let v = 0;
  for (let k = 0; k < digits; k++) {
    const h = hexValue(bytes[at + k]!);
    if (h < 0) return -1;
    v = v * 16 + h;
  }
  return v;
}

function matches(bytes: Uint8Array, at: number, end: number, text: string): boolean {
  if (at + text.length > end) return false;
  for (let k = 0; k < text.length; k++) if (bytes[at + k] !== text.charCodeAt(k)) return false;
  return true;
}

/** Decodes the raw content of a STEP string token (delimiters excluded). */
export function decodeStepString(
  bytes: Uint8Array,
  start: number,
  end: number,
  onDiagnostic?: StringDiagnosticSink,
): string {
  // Fast path: plain ASCII with no escapes.
  let plain = true;
  for (let i = start; i < end; i++) {
    const c = bytes[i]!;
    if (c === BACKSLASH || c === QUOTE || c > 0x7e) {
      plain = false;
      break;
    }
  }
  if (plain) {
    let s = "";
    const CHUNK = 4096;
    for (let i = start; i < end; i += CHUNK) {
      const stop = Math.min(end, i + CHUNK);
      if (stop - i < 32) {
        for (let k = i; k < stop; k++) s += String.fromCharCode(bytes[k]!);
      } else {
        s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, stop)));
      }
    }
    return s;
  }

  const out: string[] = [];
  const codes: number[] = [];
  const flush = (): void => {
    if (codes.length > 0) {
      out.push(String.fromCharCode.apply(null, codes));
      codes.length = 0;
    }
  };
  let page = "A";
  let i = start;
  while (i < end) {
    const c = bytes[i]!;
    if (c === QUOTE) {
      // A doubled apostrophe encodes one apostrophe.
      codes.push(QUOTE);
      i += bytes[i + 1] === QUOTE && i + 1 < end ? 2 : 1;
      continue;
    }
    if (c > 0x7e) {
      // Raw non-ASCII run (not legal STEP, but common): prefer UTF-8.
      let j = i;
      while (j < end && bytes[j]! > 0x7e) j++;
      flush();
      try {
        utf8 ??= new TextDecoder("utf-8", { fatal: true });
        out.push(utf8.decode(bytes.subarray(i, j)));
      } catch {
        for (let k = i; k < j; k++) codes.push(bytes[k]!);
      }
      i = j;
      continue;
    }
    if (c !== BACKSLASH) {
      codes.push(c);
      if (codes.length > 4096) flush();
      i++;
      continue;
    }
    // Escape directive.
    if (bytes[i + 1] === BACKSLASH && i + 1 < end) {
      codes.push(BACKSLASH);
      i += 2;
      continue;
    }
    if (matches(bytes, i, end, "\\X2\\") || matches(bytes, i, end, "\\X4\\")) {
      const width = bytes[i + 2] === 0x32 ? 4 : 8;
      let j = i + 4;
      let ok = false;
      const units: number[] = [];
      while (j < end) {
        if (matches(bytes, j, end, "\\X0\\")) {
          ok = true;
          j += 4;
          break;
        }
        const v = readHex(bytes, j, width, end);
        if (v < 0) break;
        units.push(v);
        j += width;
      }
      if (!ok) {
        onDiagnostic?.(`malformed \\X${width === 4 ? 2 : 4}\\ escape`);
        codes.push(BACKSLASH);
        i++;
        continue;
      }
      if (width === 4) {
        for (const u of units) codes.push(u);
      } else {
        for (const cp of units) {
          if (cp > 0x10ffff) {
            onDiagnostic?.(`code point out of range in \\X4\\ escape`);
            codes.push(0xfffd);
          } else if (cp > 0xffff) {
            const v = cp - 0x10000;
            codes.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
          } else {
            codes.push(cp);
          }
        }
      }
      i = j;
      continue;
    }
    if (matches(bytes, i, end, "\\X\\")) {
      const v = readHex(bytes, i + 3, 2, end);
      if (v < 0) {
        onDiagnostic?.("malformed \\X\\ escape");
        codes.push(BACKSLASH);
        i++;
        continue;
      }
      codes.push(v);
      i += 5;
      continue;
    }
    if (matches(bytes, i, end, "\\S\\") && i + 3 < end) {
      const v = bytes[i + 3]! + 0x80;
      const dec = pageDecoder(page);
      if (dec) {
        flush();
        out.push(dec.decode(new Uint8Array([v])));
      } else {
        codes.push(v);
      }
      i += 4;
      continue;
    }
    if (bytes[i + 1] === 0x50 && i + 3 < end && bytes[i + 3] === BACKSLASH) {
      const p = bytes[i + 2]!;
      if (p >= 0x41 && p <= 0x49) {
        page = String.fromCharCode(p);
        i += 4;
        continue;
      }
    }
    if (matches(bytes, i, end, "\\N\\")) {
      i += 3;
      continue;
    }
    onDiagnostic?.("unrecognised escape sequence");
    codes.push(BACKSLASH);
    i++;
  }
  flush();
  return out.join("");
}

/** Encodes a JavaScript string as STEP string content (without delimiters). */
export function encodeStepString(value: string): string {
  let out = "";
  let run: number[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    const needsX4 = run.some((u) => u > 0xffff);
    if (needsX4) {
      out += "\\X4\\" + run.map((u) => u.toString(16).toUpperCase().padStart(8, "0")).join("") + "\\X0\\";
    } else {
      out += "\\X2\\" + run.map((u) => u.toString(16).toUpperCase().padStart(4, "0")).join("") + "\\X0\\";
    }
    run = [];
  };
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) {
      flushRun();
      if (ch === "'") out += "''";
      else if (ch === "\\") out += "\\\\";
      else out += ch;
    } else {
      run.push(cp);
    }
  }
  flushRun();
  return out;
}
