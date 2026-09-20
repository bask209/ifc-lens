// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeStepString, encodeStepString } from "../../src/step/step-string.ts";

function decode(raw: string | Uint8Array): { value: string; diags: string[] } {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  const diags: string[] = [];
  const value = decodeStepString(bytes, 0, bytes.length, (m) => diags.push(m));
  return { value, diags };
}

describe("STEP string decoding", () => {
  it("collapses doubled apostrophes and backslashes", () => {
    assert.equal(decode("it''s").value, "it's");
    assert.equal(decode("a\\\\b").value, "a\\b");
  });

  it("decodes \\X2\\ (UTF-16) and \\X4\\ (UCS-4) sequences", () => {
    assert.equal(decode("Caf\\X2\\00E9\\X0\\").value, "Café");
    assert.equal(decode("\\X2\\00E900F1\\X0\\").value, "éñ");
    assert.equal(decode("\\X4\\0001F600\\X0\\").value, "😀");
    assert.equal(decode("\\X2\\D83DDE00\\X0\\").value, "😀");
  });

  it("decodes \\X\\hh and \\S\\ with code pages", () => {
    assert.equal(decode("\\X\\E9t\\X\\E9").value, "été");
    assert.equal(decode("\\S\\i").value, "é"); // 'i' (0x69) + 0x80 = 0xE9
    assert.equal(decode("\\PB\\\\S\\1").value, "ą"); // ISO 8859-2 0xB1
  });

  it("decodes raw UTF-8 bytes and falls back to Latin-1", () => {
    assert.equal(decode(new TextEncoder().encode("Größe")).value, "Größe");
    assert.equal(decode(new Uint8Array([0x47, 0xf6])).value, "Gö");
  });

  it("reports malformed escapes and keeps the text", () => {
    const r = decode("bad\\X2\\00E\\X0\\ tail");
    assert.ok(r.diags.length >= 1);
    assert.match(r.diags[0]!, /malformed \\X2\\ escape/);
    assert.ok(r.value.startsWith("bad\\X2\\") && r.value.endsWith(" tail"));
    const r2 = decode("x\\Q\\y");
    assert.equal(r2.diags.length, 2); // one per unrecognised backslash
    assert.equal(r2.value, "x\\Q\\y");
  });

  it("round-trips through the encoder", () => {
    for (const s of ["plain", "it's", "back\\slash", "Ünïcödé ✓", "emoji 😀 mix", "<script>alert(1)</script>"]) {
      assert.equal(decode(encodeStepString(s)).value, s);
    }
  });
});
