// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StepTokenizer, TokenKind, type StepToken } from "../../src/step/tokenizer.ts";

interface Tok {
  kind: number;
  start: number;
  end: number;
  num: number;
  text: string;
  bytes: string;
}

function tokenize(chunks: Uint8Array[], limits = {}): Tok[] {
  const t = new StepTokenizer(limits);
  const out: Tok[] = [];
  const emit = (tok: StepToken): void => {
    out.push({ kind: tok.kind, start: tok.start, end: tok.end, num: tok.num, text: tok.text, bytes: tok.kind === TokenKind.String ? Buffer.from(tok.bytes.subarray(tok.offset, tok.offset + tok.length)).toString("latin1") : "" });
  };
  chunks.forEach((c, i) => t.push(c, i === chunks.length - 1, emit));
  if (chunks.length === 0) t.push(new Uint8Array(0), true, emit);
  return out;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const SAMPLE = "#123=IFCWALL('A''B','\\X2\\00E900F1\\X0\\',$,*,.T.,(1,-2.5E-3,#7),IFCLABEL('x'),\"0AF\");/* comment */#9=X();";

describe("STEP tokenizer", () => {
  it("recognises every token kind", () => {
    const toks = tokenize([enc(SAMPLE)]);
    const kinds = toks.map((t) => t.kind);
    assert.deepEqual(kinds.slice(0, 5), [TokenKind.HashId, TokenKind.Equals, TokenKind.Keyword, TokenKind.OpenParen, TokenKind.String]);
    assert.equal(toks[0]!.num, 123);
    assert.equal(toks[2]!.text, "IFCWALL");
    assert.equal(toks[4]!.bytes, "A''B");
    assert.ok(kinds.includes(TokenKind.Dollar));
    assert.ok(kinds.includes(TokenKind.Asterisk));
    assert.ok(kinds.includes(TokenKind.Enumeration));
    assert.ok(kinds.includes(TokenKind.Binary));
    const real = toks.find((t) => t.kind === TokenKind.Real)!;
    assert.equal(real.num, -2.5e-3);
    const integers = toks.filter((t) => t.kind === TokenKind.Integer).map((t) => t.num);
    assert.deepEqual(integers, [1]);
    assert.equal(toks.filter((t) => t.kind === TokenKind.Invalid).length, 0);
  });

  it("produces identical tokens for every possible two-chunk split", () => {
    const bytes = enc(SAMPLE);
    const whole = tokenize([bytes]);
    for (let split = 1; split < bytes.length; split++) {
      const streamed = tokenize([bytes.slice(0, split), bytes.slice(split)]);
      assert.deepEqual(streamed, whole, `split at ${split}`);
    }
  });

  it("is invariant to one-byte chunks", () => {
    const bytes = enc(SAMPLE);
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    assert.deepEqual(tokenize(chunks), tokenize([bytes]));
  });

  it("keeps offsets monotonic and consistent with the source", () => {
    const toks = tokenize([enc(SAMPLE)]);
    let last = -1;
    for (const t of toks) {
      assert.ok(t.start >= last, "monotonic start");
      assert.ok(t.end > t.start);
      last = t.end;
    }
    assert.equal(SAMPLE.slice(toks[2]!.start, toks[2]!.end), "IFCWALL");
  });

  it("parses numbers with signs, exponents and lenient leading dots", () => {
    const toks = tokenize([enc("1 +2 -3 1. 1.5 -0.25 1.E3 2.5e-2 .5")]);
    assert.deepEqual(toks.map((t) => [t.kind, t.num]), [
      [TokenKind.Integer, 1], [TokenKind.Integer, 2], [TokenKind.Integer, -3], [TokenKind.Real, 1], [TokenKind.Real, 1.5],
      [TokenKind.Real, -0.25], [TokenKind.Real, 1000], [TokenKind.Real, 0.025], [TokenKind.Real, 0.5],
    ]);
  });

  it("reports malformed numbers as invalid tokens and continues", () => {
    const toks = tokenize([enc("1.2.3,- ,1E,5")]);
    assert.equal(toks[0]!.kind, TokenKind.Invalid);
    assert.match(toks[0]!.text, /malformed number/);
    assert.equal(toks.at(-1)!.kind, TokenKind.Integer);
    assert.equal(toks.at(-1)!.num, 5);
  });

  it("reports unterminated strings, comments and unexpected characters", () => {
    assert.match(tokenize([enc("'abc")]).at(-1)!.text, /inside a token/);
    assert.match(tokenize([enc("/* never closed")]).at(-1)!.text, /unterminated comment/);
    const t = tokenize([enc("%;")]);
    assert.equal(t[0]!.kind, TokenKind.Invalid);
    assert.equal(t[1]!.kind, TokenKind.Semicolon);
  });

  it("handles comments split across chunks, including '*' runs", () => {
    const src = enc("#1/* a ** b */=/***/X;");
    const whole = tokenize([src]);
    assert.deepEqual(whole.map((t) => t.kind), [TokenKind.HashId, TokenKind.Equals, TokenKind.Keyword, TokenKind.Semicolon]);
    for (let s = 1; s < src.length; s++) assert.deepEqual(tokenize([src.slice(0, s), src.slice(s)]), whole);
  });

  it("enforces token and string limits without buffering the payload", () => {
    const longKeyword = "A".repeat(100);
    const k = tokenize([enc(`${longKeyword};`)], { maxTokenBytes: 10 });
    assert.equal(k[0]!.kind, TokenKind.Invalid);
    assert.match(k[0]!.text, /maxTokenBytes/);
    const s = tokenize([enc(`'${"x".repeat(1000)}',1`)], { maxStringBytes: 100 });
    assert.equal(s[0]!.kind, TokenKind.Invalid);
    assert.match(s[0]!.text, /maxStringBytes/);
    assert.equal(s.at(-1)!.num, 1);
  });

  it("rejects instance names that are too long", () => {
    const t = tokenize([enc("#12345678901234567890=")]);
    assert.equal(t[0]!.kind, TokenKind.Invalid);
  });

  it("always makes progress on random bytes", () => {
    let seed = 42;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 50; n++) {
      const bytes = new Uint8Array(500);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rnd() * 256);
      const toks = tokenize([bytes.slice(0, 250), bytes.slice(250)]);
      for (let i = 1; i < toks.length; i++) assert.ok(toks[i]!.start >= toks[i - 1]!.start);
    }
  });
});
