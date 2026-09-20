// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IfcResourceLimitError, StepFormatError } from "../../src/diagnostics.ts";
import { parseStepBytes, parseStepStream, parseStepText } from "../../src/step/parser.ts";
import type { StepValue } from "../../src/step/store.ts";
import { serializeValue } from "../../src/step/writer.ts";

const wrap = (data: string, schema = "IFC4"): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\nFILE_NAME('a.ifc','2026-01-01',('me'),('org'),'pre','sys','auth');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;

function entity(text: string, id: number): StepValue[] {
  const p = parseStepText(text);
  const k = p.store.indexOfId(id);
  assert.ok(k >= 0, `entity #${id} missing`);
  return p.store.argsValue(k);
}

describe("STEP physical file parser", () => {
  it("reads the header", () => {
    const p = parseStepText(wrap("#1=IFCWALL($);"));
    assert.deepEqual(p.header.schemaIdentifiers, ["IFC4"]);
    assert.equal(p.header.fileName, "a.ifc");
    assert.deepEqual(p.header.author, ["me"]);
    assert.equal(p.header.originatingSystem, "sys");
    assert.deepEqual(p.header.fileDescription, ["ViewDefinition [CoordinationView]"]);
  });

  it("decodes every value category", () => {
    const args = entity(wrap("#5=X($,*,12,-1.5E2,'s''t',.ENUM.,#9,(1,(2,3)),IFCLABEL('lbl'),\"0F\",());"), 5);
    assert.deepEqual(args, [
      { kind: "null" },
      { kind: "derived" },
      { kind: "integer", value: 12 },
      { kind: "real", value: -150 },
      { kind: "string", value: "s't" },
      { kind: "enum", value: "ENUM" },
      { kind: "ref", id: 9 },
      { kind: "list", values: [{ kind: "integer", value: 1 }, { kind: "list", values: [{ kind: "integer", value: 2 }, { kind: "integer", value: 3 }] }] },
      { kind: "typed", type: "IFCLABEL", args: [{ kind: "string", value: "lbl" }] },
      { kind: "binary", value: "0F" },
      { kind: "list", values: [] },
    ]);
  });

  it("keeps logical enumerations as enumerations", () => {
    const args = entity(wrap("#1=X(.T.,.F.,.U.);"), 1);
    assert.deepEqual(args.map((a) => a.kind), ["enum", "enum", "enum"]);
  });

  it("allows forward references and resolves them lazily", () => {
    const p = parseStepText(wrap("#1=A(#2);#2=B(1);"));
    const s = p.store;
    assert.equal(s.ref(s.arg(s.indexOfId(1), 0)), 2);
    assert.equal(s.typeOf(2), "B");
    assert.equal(s.typeOf(3), undefined);
  });

  it("stores big integers and big ids", () => {
    const p = parseStepText(wrap("#2147483000=X(99999999999,-3000000000);"));
    const args = p.store.argsValue(p.store.indexOfId(2147483000));
    assert.deepEqual(args, [{ kind: "integer", value: 99999999999 }, { kind: "integer", value: -3000000000 }]);
  });

  it("supports complex (external mapping) instances", () => {
    const p = parseStepText(wrap("#7=(A(1)B('x',2)C());"));
    const k = p.store.indexOfId(7);
    assert.equal(p.store.typeNameAt(k), "A+B+C");
    assert.deepEqual(p.store.argsValue(k), [
      { kind: "typed", type: "A", args: [{ kind: "integer", value: 1 }] },
      { kind: "typed", type: "B", args: [{ kind: "string", value: "x" }, { kind: "integer", value: 2 }] },
      { kind: "typed", type: "C", args: [] },
    ]);
  });

  it("recovers from a malformed statement and keeps the next entity", () => {
    const p = parseStepText(wrap("#1=A(1,,2);\n#2=B(3);\n#3 C(4);\n#4=D(5);"));
    assert.equal(p.store.entityCount, 2);
    assert.ok(p.store.hasId(2) && p.store.hasId(4));
    assert.equal(p.diagnostics.count("STEP_SYNTAX"), 2);
    // committed entities are not damaged by a later syntax error
    assert.deepEqual(p.store.argsValue(p.store.indexOfId(2)), [{ kind: "integer", value: 3 }]);
  });

  it("does not roll back a committed entity when the following statement is malformed", () => {
    const p = parseStepText(wrap("#1=A((1,2),'x');\n= garbage ;\n#2=B(#1);"));
    assert.deepEqual(p.store.argsValue(p.store.indexOfId(1)), [
      { kind: "list", values: [{ kind: "integer", value: 1 }, { kind: "integer", value: 2 }] },
      { kind: "string", value: "x" },
    ]);
    assert.ok(p.store.hasId(2));
  });

  it("rejects empty-list tricks and trailing commas", () => {
    const p = parseStepText(wrap("#1=A((),);#2=A((1),);#3=A((),());"));
    assert.ok(!p.store.hasId(1));
    assert.ok(!p.store.hasId(2));
    assert.ok(p.store.hasId(3));
  });

  it("reports duplicate instance names and keeps the first", () => {
    const p = parseStepText(wrap("#1=A(1);#1=B(2);"));
    assert.equal(p.store.typeOf(1), "A");
    assert.equal(p.diagnostics.count("STEP_DUPLICATE_ID"), 1);
  });

  it("handles a missing END-ISO-10303-21 and truncated input", () => {
    const truncated = wrap("#1=A(1);#2=B('unterminated").split("ENDSEC;\nEND")[0]!;
    const p = parseStepText(truncated);
    assert.ok(p.store.hasId(1));
    assert.ok(!p.store.hasId(2));
    assert.ok(p.diagnostics.count("STEP_SYNTAX") >= 1);
  });

  it("rejects files that are not STEP", () => {
    assert.throws(() => parseStepText("hello world"), StepFormatError);
    assert.throws(() => parseStepText("ISO-10303-21;HEADER;ENDSEC;END-ISO-10303-21;"), /No DATA section/);
  });

  it("accepts edition-3 named DATA sections and multiple data sections", () => {
    const p = parseStepText("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA('a',('IFC4'));#1=A();ENDSEC;DATA;#2=B();ENDSEC;END-ISO-10303-21;");
    assert.equal(p.store.entityCount, 2);
  });

  it("enforces the aggregate nesting limit", () => {
    const deep = "(".repeat(100) + ")".repeat(100);
    const p = parseStepText(wrap(`#1=A(${deep});#2=B(1);`), { limits: { maxAggregateDepth: 20 } });
    assert.ok(!p.store.hasId(1));
    assert.ok(p.store.hasId(2));
    assert.equal(p.diagnostics.count("RESOURCE_LIMIT"), 1);
  });

  it("enforces entity and file size limits", () => {
    assert.throws(() => parseStepText(wrap("#1=A();#2=A();#3=A();"), { limits: { maxEntities: 2 } }), IfcResourceLimitError);
    assert.throws(() => parseStepText(wrap("#1=A();"), { limits: { maxFileBytes: 20 } }), IfcResourceLimitError);
  });

  it("parses streams identically to buffers across chunk boundaries", async () => {
    const text = wrap("#1=IFCWALL('A''B','\\X2\\00E9\\X0\\',$,*,.T.,(1,-2.5E-3,#7),IFCLABEL('x'));/* c */#7=IFCX((1.,2.,3.));");
    const bytes = new TextEncoder().encode(text);
    const reference = parseStepBytes(bytes);
    for (const size of [1, 2, 3, 7, 64]) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
          c.close();
        },
      });
      const p = await parseStepStream(stream);
      assert.equal(p.store.entityCount, reference.store.entityCount);
      for (const id of [1, 7]) assert.deepEqual(p.store.argsValue(p.store.indexOfId(id)), reference.store.argsValue(reference.store.indexOfId(id)));
    }
  });

  it("indexes entities by type and id (dense and sparse id tables)", () => {
    const dense = parseStepText(wrap("#1=A();#2=B();#3=A();"));
    assert.deepEqual(dense.store.idsOfType("A"), [1, 3]);
    const sparse = parseStepText(wrap("#10=A();#900000000=A();"));
    assert.deepEqual(sparse.store.idsOfType("A"), [10, 900000000]);
    assert.equal(sparse.store.indexOfId(5), -1);
  });

  it("round-trips randomly generated values (property-based)", () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const gen = (depth: number): StepValue => {
      const r = rnd();
      if (depth > 3 || r < 0.55) {
        const k = Math.floor(rnd() * 8);
        switch (k) {
          case 0: return { kind: "null" };
          case 1: return { kind: "derived" };
          case 2: return { kind: "integer", value: Math.floor((rnd() - 0.5) * 1e6) };
          case 3: return { kind: "real", value: (rnd() - 0.5) * 10 ** Math.floor(rnd() * 12 - 6) };
          case 4: return { kind: "string", value: ["", "a'b", "\\", "é✓", "x".repeat(Math.floor(rnd() * 20))][Math.floor(rnd() * 5)]! };
          case 5: return { kind: "enum", value: ["T", "F", "U", "NOTDEFINED"][Math.floor(rnd() * 4)]! };
          case 6: return { kind: "ref", id: 1 + Math.floor(rnd() * 1000) };
          default: return { kind: "binary", value: "0ABC" };
        }
      }
      if (r < 0.8) return { kind: "list", values: Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth + 1)) };
      return { kind: "typed", type: "IFCT" + Math.floor(rnd() * 5), args: [gen(depth + 1)] };
    };
    for (let n = 0; n < 300; n++) {
      const args = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => gen(0));
      const text = wrap(`#1=X(${args.map(serializeValue).join(",")});`);
      const parsed = entity(text, 1);
      assert.deepEqual(parsed, args);
    }
  });
});
