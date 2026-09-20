// SPDX-License-Identifier: Apache-2.0
/**
 * Streaming ISO 10303-21 tokenizer operating on bytes.
 *
 * Every lexical state survives chunk boundaries: feeding a file as one chunk or
 * as N arbitrary chunks yields the identical token sequence. The tokenizer
 * reuses a single token object and a single scratch buffer, so consumers must
 * copy whatever they need before returning from the callback.
 */

export const TokenKind = {
  /** `#123` — `num` holds the instance name. */
  HashId: 0,
  /** Keyword / entity type name / section keyword. `text` holds it. */
  Keyword: 1,
  Integer: 2,
  Real: 3,
  /** Raw, still-escaped bytes between the apostrophes are in `bytes[0..length)`. */
  String: 4,
  /** `.NAME.` — `text` holds NAME. */
  Enumeration: 5,
  /** `"0ABC"` — `text` holds the hex payload. */
  Binary: 6,
  Dollar: 7,
  Asterisk: 8,
  OpenParen: 9,
  CloseParen: 10,
  Comma: 11,
  Equals: 12,
  Semicolon: 13,
  /** Malformed or over-limit input. `text` holds a human-readable reason. */
  Invalid: 14,
} as const;
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

export const TOKEN_KIND_NAMES: readonly string[] = [
  "#id", "keyword", "integer", "real", "string", "enumeration", "binary",
  "$", "*", "(", ")", ",", "=", ";", "invalid",
];

export interface StepToken {
  kind: TokenKind;
  /** Absolute byte offset of the first byte of the token. */
  start: number;
  /** Absolute byte offset one past the last byte of the token. */
  end: number;
  num: number;
  text: string;
  /** Scratch view; valid only during the callback. String bytes are bytes[offset, offset+length). */
  bytes: Uint8Array;
  offset: number;
  length: number;
}

export interface TokenizerLimits {
  /** Longest keyword/number/enumeration/binary token accepted. */
  maxTokenBytes: number;
  /** Longest string literal accepted (raw bytes). */
  maxStringBytes: number;
}

export const DEFAULT_TOKENIZER_LIMITS: TokenizerLimits = {
  maxTokenBytes: 4096,
  maxStringBytes: 16 * 1024 * 1024,
};

const enum_ = {
  Normal: 0,
  Hash: 1,
  Keyword: 2,
  Number: 3,
  String: 4,
  StringQuote: 5,
  StringSkip: 6,
  StringSkipQuote: 7,
  Enum: 8,
  Binary: 9,
  Slash: 10,
  Comment: 11,
  CommentStar: 12,
  Dot: 13,
} as const;
type LexState = (typeof enum_)[keyof typeof enum_];

const CH_QUOTE = 0x27;
const CH_DQUOTE = 0x22;
const CH_HASH = 0x23;
const CH_DOT = 0x2e;
const CH_SLASH = 0x2f;
const CH_STAR = 0x2a;

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}
function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
function isKeywordStart(c: number): boolean {
  return isLetter(c) || c === 0x5f /* _ */ || c === 0x21 /* ! user-defined */;
}
function isKeywordPart(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === 0x5f || c === 0x2d /* - (ISO-10303-21) */;
}
function isNumberPart(c: number): boolean {
  return isDigit(c) || c === CH_DOT || c === 0x45 || c === 0x65 || c === 0x2b || c === 0x2d;
}
function isEnumPart(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === 0x5f;
}
function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}
function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x0b || c === 0;
}

const CLASS_KEYWORD = 1, CLASS_DIGIT = 2, CLASS_NUMBER = 4, CLASS_ENUM = 8, CLASS_SPACE = 16;
/** Byte classification table for the hot loops. */
const CLASS = new Uint8Array(256);
for (let c = 0; c < 256; c++) {
  let k = 0;
  if (isKeywordPart(c)) k |= CLASS_KEYWORD;
  if (isDigit(c)) k |= CLASS_DIGIT;
  if (isNumberPart(c)) k |= CLASS_NUMBER;
  if (isEnumPart(c)) k |= CLASS_ENUM;
  if (isWhitespace(c)) k |= CLASS_SPACE;
  CLASS[c] = k;
}

const POW10 = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

/** Decodes a short ASCII byte range without allocating intermediate arrays. */
export function asciiString(bytes: Uint8Array, start: number, end: number): string {
  if (end - start <= 64) {
    let s = "";
    for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
    return s;
  }
  let s = "";
  const CHUNK = 8192;
  for (let i = start; i < end; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(end, i + CHUNK))));
  }
  return s;
}

export class StepTokenizer {
  private readonly limits: TokenizerLimits;
  private state: LexState = enum_.Normal;
  private buf = new Uint8Array(256);
  private len = 0;
  /** Absolute offset of the first byte of the current chunk. */
  private base = 0;
  private tokenStart = 0;
  private overflow = false;
  private readonly keywords = new Map<number, string[]>();
  private readonly token: StepToken;

  constructor(limits: Partial<TokenizerLimits> = {}) {
    this.limits = { ...DEFAULT_TOKENIZER_LIMITS, ...limits };
    this.token = { kind: TokenKind.Invalid, start: 0, end: 0, num: 0, text: "", bytes: this.buf, offset: 0, length: 0 };
  }

  /** Total number of bytes consumed so far. */
  get bytesConsumed(): number {
    return this.base;
  }

  reset(): void {
    this.state = enum_.Normal;
    this.len = 0;
    this.base = 0;
    this.overflow = false;
  }

  private append(c: number): void {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = c;
  }

  private appendRange(chunk: Uint8Array, from: number, to: number): void {
    const n = to - from;
    if (n <= 0) return;
    if (this.len + n > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < this.len + n) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk.subarray(from, to), this.len);
    this.len += n;
  }

  /** Appends a run of token bytes, flagging overflow past maxTokenBytes. */
  private appendRun(chunk: Uint8Array, from: number, to: number): void {
    if (this.overflow || to <= from) return;
    if (this.len + (to - from) > this.limits.maxTokenBytes) {
      this.overflow = true;
      return;
    }
    this.appendRange(chunk, from, to);
  }

  private emit(emit: (t: StepToken) => void, kind: TokenKind, end: number, num = 0, text = "", src: Uint8Array = this.buf, off = 0, len = this.len): void {
    const t = this.token;
    t.kind = kind;
    t.start = this.tokenStart;
    t.end = end;
    t.num = num;
    t.text = text;
    t.bytes = src;
    t.offset = off;
    t.length = len;
    emit(t);
  }

  private invalid(emit: (t: StepToken) => void, end: number, reason: string): void {
    this.len = 0;
    this.emit(emit, TokenKind.Invalid, end, 0, reason);
  }

  /**
   * Consumes one chunk. With `final`, any token still open is completed or
   * reported as truncated.
   */
  push(chunk: Uint8Array, final: boolean, emit: (t: StepToken) => void): void {
    const n = chunk.length;
    let i = 0;
    const base = this.base;
    while (i < n) {
      const c = chunk[i]!;
      switch (this.state) {
        case enum_.Normal: {
          if (CLASS[c]! & CLASS_SPACE) {
            i++;
            while (i < n && CLASS[chunk[i]!]! & CLASS_SPACE) i++;
            continue;
          }
          this.tokenStart = base + i;
          this.len = 0;
          this.overflow = false;
          if (c === CH_HASH) {
            let j = i + 1;
            while (j < n && CLASS[chunk[j]!]! & CLASS_DIGIT) j++;
            if (j < n && j - i - 1 <= this.limits.maxTokenBytes) {
              // zero-copy: the whole token lies inside this chunk
              this.finishHash(emit, base + j, chunk, i + 1, j - i - 1);
              i = j;
            } else {
              this.state = enum_.Hash;
              i++;
            }
          } else if (isKeywordStart(c)) {
            let j = i + 1;
            while (j < n && CLASS[chunk[j]!]! & CLASS_KEYWORD) j++;
            if (j < n && j - i <= this.limits.maxTokenBytes) {
              this.finishKeyword(emit, base + j, chunk, i, j - i);
              i = j;
            } else {
              this.state = enum_.Keyword;
              this.append(c);
              i++;
            }
          } else if (isDigit(c) || c === 0x2b || c === 0x2d) {
            let j = i + 1;
            while (j < n && CLASS[chunk[j]!]! & CLASS_NUMBER) j++;
            if (j < n && j - i <= this.limits.maxTokenBytes) {
              this.finishNumber(emit, base + j, chunk, i, j - i);
              i = j;
            } else {
              this.state = enum_.Number;
              this.append(c);
              i++;
            }
          } else if (c === CH_DOT) {
            this.state = enum_.Dot;
            i++;
          } else if (c === CH_QUOTE) {
            const q = chunk.indexOf(CH_QUOTE, i + 1);
            if (q >= 0 && q + 1 < n && chunk[q + 1] !== CH_QUOTE && q - i - 1 <= this.limits.maxStringBytes) {
              // zero-copy string without doubled apostrophes
              i = q + 1;
              this.emit(emit, TokenKind.String, base + i, 0, "", chunk, this.tokenStart - base + 1, q - (this.tokenStart - base) - 1);
            } else {
              this.state = enum_.String;
              i++;
            }
          } else if (c === CH_DQUOTE) {
            this.state = enum_.Binary;
            i++;
          } else if (c === CH_SLASH) {
            this.state = enum_.Slash;
            i++;
          } else {
            i++;
            const end = base + i;
            switch (c) {
              case 0x24: this.emit(emit, TokenKind.Dollar, end); break;
              case CH_STAR: this.emit(emit, TokenKind.Asterisk, end); break;
              case 0x28: this.emit(emit, TokenKind.OpenParen, end); break;
              case 0x29: this.emit(emit, TokenKind.CloseParen, end); break;
              case 0x2c: this.emit(emit, TokenKind.Comma, end); break;
              case 0x3d: this.emit(emit, TokenKind.Equals, end); break;
              case 0x3b: this.emit(emit, TokenKind.Semicolon, end); break;
              default:
                this.invalid(emit, end, `unexpected character 0x${c.toString(16).padStart(2, "0")}`);
            }
          }
          continue;
        }
        case enum_.Hash: {
          let j = i;
          while (j < n && CLASS[chunk[j]!]! & CLASS_DIGIT) j++;
          this.appendRun(chunk, i, j);
          i = j;
          if (j < n) this.finishHash(emit, base + i); // the terminating byte is reprocessed in Normal
          continue;
        }
        case enum_.Keyword: {
          let j = i;
          while (j < n && CLASS[chunk[j]!]! & CLASS_KEYWORD) j++;
          this.appendRun(chunk, i, j);
          i = j;
          if (j < n) this.finishKeyword(emit, base + i); // the terminating byte is reprocessed in Normal
          continue;
        }
        case enum_.Number: {
          let j = i;
          while (j < n && CLASS[chunk[j]!]! & CLASS_NUMBER) j++;
          this.appendRun(chunk, i, j);
          i = j;
          if (j < n) this.finishNumber(emit, base + i); // the terminating byte is reprocessed in Normal
          continue;
        }
        case enum_.Dot: {
          if (isDigit(c)) {
            // Lenient: ".5" is not legal STEP but is produced by some exporters.
            this.append(0x30);
            this.append(CH_DOT);
            this.state = enum_.Number;
            continue;
          }
          if (isEnumPart(c)) {
            this.state = enum_.Enum;
            continue;
          }
          this.state = enum_.Normal;
          this.invalid(emit, base + i, "unexpected '.'");
          continue;
        }
        case enum_.Enum: {
          if (isEnumPart(c)) {
            if (this.len >= this.limits.maxTokenBytes) this.overflow = true;
            else this.append(c);
            i++;
            continue;
          }
          if (c === CH_DOT) {
            i++;
            this.state = enum_.Normal;
            if (this.overflow) this.invalid(emit, base + i, "enumeration exceeds maxTokenBytes");
            else this.emit(emit, TokenKind.Enumeration, base + i, 0, asciiString(this.buf, 0, this.len).toUpperCase());
            continue;
          }
          this.state = enum_.Normal;
          this.invalid(emit, base + i, "unterminated enumeration");
          continue;
        }
        case enum_.String: {
          const q = chunk.indexOf(CH_QUOTE, i);
          const stop = q < 0 ? n : q;
          if (this.len + (stop - i) > this.limits.maxStringBytes) {
            this.state = enum_.StringSkip;
            this.len = 0;
            continue;
          }
          this.appendRange(chunk, i, stop);
          i = stop;
          if (q >= 0) {
            i++;
            this.state = enum_.StringQuote;
          }
          continue;
        }
        case enum_.StringQuote: {
          if (c === CH_QUOTE) {
            // Doubled apostrophe: keep both bytes, the string decoder collapses them.
            if (this.len + 2 > this.limits.maxStringBytes) {
              this.state = enum_.StringSkip;
              this.len = 0;
            } else {
              this.append(CH_QUOTE);
              this.append(CH_QUOTE);
              this.state = enum_.String;
            }
            i++;
            continue;
          }
          this.state = enum_.Normal;
          this.emit(emit, TokenKind.String, base + i);
          continue;
        }
        case enum_.StringSkip: {
          const q = chunk.indexOf(CH_QUOTE, i);
          if (q < 0) {
            i = n;
            continue;
          }
          i = q + 1;
          this.state = enum_.StringSkipQuote;
          continue;
        }
        case enum_.StringSkipQuote: {
          if (c === CH_QUOTE) {
            i++;
            this.state = enum_.StringSkip;
            continue;
          }
          this.state = enum_.Normal;
          this.invalid(emit, base + i, `string exceeds maxStringBytes (${this.limits.maxStringBytes})`);
          continue;
        }
        case enum_.Binary: {
          if (c === CH_DQUOTE) {
            i++;
            this.state = enum_.Normal;
            if (this.overflow) this.invalid(emit, base + i, "binary exceeds maxTokenBytes");
            else this.emit(emit, TokenKind.Binary, base + i, 0, asciiString(this.buf, 0, this.len).toUpperCase());
            continue;
          }
          if (!isHexDigit(c)) {
            this.state = enum_.Normal;
            this.invalid(emit, base + i, "invalid character in binary literal");
            continue;
          }
          if (this.len >= this.limits.maxTokenBytes) this.overflow = true;
          else this.append(c);
          i++;
          continue;
        }
        case enum_.Slash: {
          if (c === CH_STAR) {
            this.state = enum_.Comment;
            i++;
            continue;
          }
          this.state = enum_.Normal;
          this.invalid(emit, base + i, "unexpected '/'");
          continue;
        }
        case enum_.Comment: {
          const s = chunk.indexOf(CH_STAR, i);
          if (s < 0) {
            i = n;
            continue;
          }
          i = s + 1;
          this.state = enum_.CommentStar;
          continue;
        }
        case enum_.CommentStar: {
          if (c === CH_SLASH) this.state = enum_.Normal;
          else if (c !== CH_STAR) this.state = enum_.Comment;
          i++;
          continue;
        }
      }
    }
    this.base = base + n;
    if (final) this.finish(emit);
  }

  private finish(emit: (t: StepToken) => void): void {
    const end = this.base;
    switch (this.state) {
      case enum_.Normal:
      case enum_.CommentStar:
        break;
      case enum_.Hash: this.finishHash(emit, end); break;
      case enum_.Keyword: this.finishKeyword(emit, end); break;
      case enum_.Number: this.finishNumber(emit, end); break;
      case enum_.StringQuote:
        this.state = enum_.Normal;
        this.emit(emit, TokenKind.String, end);
        break;
      case enum_.StringSkipQuote:
        this.state = enum_.Normal;
        this.invalid(emit, end, `string exceeds maxStringBytes (${this.limits.maxStringBytes})`);
        break;
      case enum_.Comment:
        this.state = enum_.Normal;
        this.invalid(emit, end, "unterminated comment");
        break;
      default:
        this.state = enum_.Normal;
        this.invalid(emit, end, "input ends inside a token");
    }
    this.state = enum_.Normal;
  }

  private finishHash(emit: (t: StepToken) => void, end: number, src: Uint8Array = this.buf, off = 0, len = this.len): void {
    this.state = enum_.Normal;
    if (len === 0) {
      this.invalid(emit, end, "'#' not followed by digits");
      return;
    }
    if (this.overflow || len > 15) {
      this.invalid(emit, end, "instance name too large");
      return;
    }
    let v = 0;
    for (let k = 0; k < len; k++) v = v * 10 + (src[off + k]! - 0x30);
    this.emit(emit, TokenKind.HashId, end, v);
  }

  private finishKeyword(emit: (t: StepToken) => void, end: number, src: Uint8Array = this.buf, off = 0, len = this.len): void {
    this.state = enum_.Normal;
    if (this.overflow) {
      this.invalid(emit, end, "keyword exceeds maxTokenBytes");
      return;
    }
    this.emit(emit, TokenKind.Keyword, end, 0, this.internKeyword(src, off, len));
  }

  /** Upper-case keyword text, interned by byte hash so repeated type names allocate nothing. */
  private internKeyword(buf: Uint8Array, off: number, len: number): string {
    let h = 2166136261;
    for (let k = off; k < off + len; k++) {
      let c = buf[k]!;
      if (c >= 0x61 && c <= 0x7a) c -= 32;
      h = Math.imul(h ^ c, 16777619);
    }
    const bucket = this.keywords.get(h);
    if (bucket) {
      outer: for (const s of bucket) {
        if (s.length !== len) continue;
        for (let k = 0; k < len; k++) {
          let c = buf[off + k]!;
          if (c >= 0x61 && c <= 0x7a) c -= 32;
          if (s.charCodeAt(k) !== c) continue outer;
        }
        return s;
      }
    }
    const s = asciiString(buf, off, off + len).toUpperCase();
    if (this.keywords.size < 65536) {
      if (bucket) bucket.push(s);
      else this.keywords.set(h, [s]);
    }
    return s;
  }

  private finishNumber(emit: (t: StepToken) => void, end: number, src: Uint8Array = this.buf, off = 0, length = this.len): void {
    this.state = enum_.Normal;
    if (this.overflow) {
      this.invalid(emit, end, "number exceeds maxTokenBytes");
      return;
    }
    // Single pass: validate sign? digits* (. digits*)? (E sign? digits+)? and
    // accumulate the decimal mantissa/exponent for the exact fast path.
    const stop = off + length;
    let k = off;
    let sign = 1;
    if (src[k] === 0x2d) { sign = -1; k++; } else if (src[k] === 0x2b) k++;
    let mantissa = 0;
    let digits = 0;
    let significant = 0;
    let scale = 0;
    let isReal = false;
    let c = 0;
    while (k < stop && (c = src[k]!) >= 0x30 && c <= 0x39) {
      digits++;
      if (significant > 0 || c !== 0x30) significant++;
      mantissa = mantissa * 10 + (c - 0x30);
      k++;
    }
    if (k < stop && src[k] === CH_DOT) {
      isReal = true;
      k++;
      while (k < stop && (c = src[k]!) >= 0x30 && c <= 0x39) {
        digits++;
        if (significant > 0 || c !== 0x30) significant++;
        mantissa = mantissa * 10 + (c - 0x30);
        scale--;
        k++;
      }
    }
    let ok = digits > 0;
    if (ok && k < stop && (src[k] === 0x45 || src[k] === 0x65)) {
      isReal = true;
      k++;
      let esign = 1;
      if (src[k] === 0x2d) { esign = -1; k++; } else if (src[k] === 0x2b) k++;
      let e = 0;
      let expDigits = 0;
      while (k < stop && (c = src[k]!) >= 0x30 && c <= 0x39) {
        if (e < 100000) e = e * 10 + (c - 0x30);
        expDigits++;
        k++;
      }
      ok = expDigits > 0;
      scale += esign * e;
    }
    if (!ok || k !== stop) {
      this.invalid(emit, end, `malformed number '${asciiString(src, off, stop)}'`);
      return;
    }
    let value: number;
    if (significant <= 15 && scale >= -22 && scale <= 22) {
      value = sign * (scale >= 0 ? mantissa * POW10[scale]! : mantissa / POW10[-scale]!);
    } else {
      value = Number(asciiString(src, off, stop));
    }
    if (!Number.isFinite(value)) {
      this.invalid(emit, end, `number out of range '${asciiString(src, off, stop)}'`);
      return;
    }
    this.emit(emit, isReal ? TokenKind.Real : TokenKind.Integer, end, value);
  }
}
