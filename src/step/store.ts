// SPDX-License-Identifier: Apache-2.0
/**
 * Packed, schema-independent STEP entity store.
 *
 * Values live in a pre-order arena of typed arrays. Every value is addressed by
 * an integer handle; aggregates record their child count and subtree size so a
 * list can be iterated without materialising JavaScript objects. References
 * are kept as numeric instance names and resolved lazily through `indexOfId`,
 * which makes forward references, cycles and very large models cheap.
 */

export const Tag = {
  Null: 0,
  Derived: 1,
  Integer: 2,
  Real: 3,
  String: 4,
  Enum: 5,
  Ref: 6,
  List: 7,
  Typed: 8,
  Binary: 9,
  /** Integer that does not fit into int32; value stored in the real pool. */
  BigInteger: 10,
} as const;
export type Tag = (typeof Tag)[keyof typeof Tag];

/** Materialised STEP value (convenience / test representation). */
export type StepValue =
  | { kind: "null" }
  | { kind: "derived" }
  | { kind: "integer"; value: number }
  | { kind: "real"; value: number }
  | { kind: "string"; value: string }
  | { kind: "enum"; value: string }
  | { kind: "ref"; id: number }
  | { kind: "list"; values: StepValue[] }
  | { kind: "typed"; type: string; args: StepValue[] }
  | { kind: "binary"; value: string };

export interface StepHeader {
  fileDescription: string[];
  implementationLevel: string;
  fileName: string;
  timeStamp: string;
  author: string[];
  organization: string[];
  preprocessorVersion: string;
  originatingSystem: string;
  authorization: string;
  schemaIdentifiers: string[];
}

export function emptyHeader(): StepHeader {
  return {
    fileDescription: [],
    implementationLevel: "",
    fileName: "",
    timeStamp: "",
    author: [],
    organization: [],
    preprocessorVersion: "",
    originatingSystem: "",
    authorization: "",
    schemaIdentifiers: [],
  };
}

function growU8(a: Uint8Array<ArrayBuffer>, need: number): Uint8Array<ArrayBuffer> {
  if (need <= a.length) return a;
  let cap = Math.max(16, a.length * 2);
  while (cap < need) cap *= 2;
  const b = new Uint8Array(cap);
  b.set(a);
  return b;
}
function growI32(a: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
  if (need <= a.length) return a;
  let cap = Math.max(16, a.length * 2);
  while (cap < need) cap *= 2;
  const b = new Int32Array(cap);
  b.set(a);
  return b;
}
function growU32(a: Uint32Array<ArrayBuffer>, need: number): Uint32Array<ArrayBuffer> {
  if (need <= a.length) return a;
  let cap = Math.max(16, a.length * 2);
  while (cap < need) cap *= 2;
  const b = new Uint32Array(cap);
  b.set(a);
  return b;
}
function growF64(a: Float64Array<ArrayBuffer>, need: number): Float64Array<ArrayBuffer> {
  if (need <= a.length) return a;
  let cap = Math.max(16, a.length * 2);
  while (cap < need) cap *= 2;
  const b = new Float64Array(cap);
  b.set(a);
  return b;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Interning table for short identifiers (entity/type/enum names). */
class NameTable {
  readonly names: string[] = [];
  private readonly map = new Map<string, number>();
  intern(name: string): number {
    let id = this.map.get(name);
    if (id === undefined) {
      id = this.names.length;
      this.names.push(name);
      this.map.set(name, id);
    }
    return id;
  }
  lookup(name: string): number {
    return this.map.get(name) ?? -1;
  }
}

export class StepStore {
  // ---- value arena ----
  tags = new Uint8Array(1 << 12);
  payload = new Int32Array(1 << 12);
  valueCount = 0;
  reals = new Float64Array(1 << 10);
  realCount = 0;
  aggCount = new Uint32Array(1 << 10);
  aggSize = new Uint32Array(1 << 10);
  aggType = new Int32Array(1 << 10);
  aggTotal = 0;
  readonly strings: string[] = [];
  private readonly enumTable = new NameTable();
  private readonly nameTable = new NameTable();

  // ---- entities ----
  entityIds = new Uint32Array(1 << 10);
  entityTypes = new Uint32Array(1 << 10);
  entityArgs = new Uint32Array(1 << 10);
  entityStart = new Uint32Array(1 << 10);
  entityEnd = new Uint32Array(1 << 10);
  entityCount = 0;
  header: StepHeader = emptyHeader();

  private idMap: Map<number, number> | null = new Map();
  private idDense: Int32Array | null = null;
  private typeOffsets: Uint32Array | null = null;
  private typeMembers: Uint32Array | null = null;
  private finalized = false;
  maxId = 0;

  // ---- builder stack (used while parsing one entity) ----
  private openStack: number[] = [];
  private rollbackValue = 0;
  private rollbackReal = 0;
  private rollbackAgg = 0;
  private rollbackString = 0;

  // ================= builder API =================

  beginEntity(): void {
    this.rollbackValue = this.valueCount;
    this.rollbackReal = this.realCount;
    this.rollbackAgg = this.aggTotal;
    this.rollbackString = this.strings.length;
    this.openStack.length = 0;
  }

  /** Discards every value written since `beginEntity()`. */
  rollbackEntity(): void {
    this.valueCount = this.rollbackValue;
    this.realCount = this.rollbackReal;
    this.aggTotal = this.rollbackAgg;
    this.strings.length = this.rollbackString;
    this.openStack.length = 0;
  }

  get depth(): number {
    return this.openStack.length;
  }

  private pushValue(tag: Tag, payload: number): number {
    const v = this.valueCount;
    if (v >= this.tags.length) {
      this.tags = growU8(this.tags, v + 1);
      this.payload = growI32(this.payload, v + 1);
    }
    this.tags[v] = tag;
    this.payload[v] = payload;
    this.valueCount = v + 1;
    const top = this.openStack.length;
    if (top > 0) this.aggCount[this.openStack[top - 1]!]!++;
    return v;
  }

  addNull(): void { this.pushValue(Tag.Null, 0); }
  addDerived(): void { this.pushValue(Tag.Derived, 0); }

  addInteger(n: number): void {
    if (Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX) {
      this.pushValue(Tag.Integer, n);
    } else {
      this.pushValue(Tag.BigInteger, this.addRealPool(n));
    }
  }

  addReal(x: number): void {
    this.pushValue(Tag.Real, this.addRealPool(x));
  }

  private addRealPool(x: number): number {
    const r = this.realCount;
    if (r >= this.reals.length) this.reals = growF64(this.reals, r + 1);
    this.reals[r] = x;
    this.realCount = r + 1;
    return r;
  }

  addString(s: string): void {
    this.strings.push(s);
    this.pushValue(Tag.String, this.strings.length - 1);
  }

  addBinary(hex: string): void {
    this.strings.push(hex);
    this.pushValue(Tag.Binary, this.strings.length - 1);
  }

  addEnum(name: string): void {
    this.pushValue(Tag.Enum, this.enumTable.intern(name));
  }

  addRef(id: number): void {
    this.pushValue(Tag.Ref, id);
  }

  private openAggregate(tag: Tag, typeId: number): number {
    const a = this.aggTotal;
    if (a >= this.aggCount.length) {
      this.aggCount = growU32(this.aggCount, a + 1);
      this.aggSize = growU32(this.aggSize, a + 1);
      this.aggType = growI32(this.aggType, a + 1);
    }
    this.aggCount[a] = 0;
    this.aggSize[a] = 0;
    this.aggType[a] = typeId;
    this.aggTotal = a + 1;
    const v = this.pushValue(tag, a);
    this.openStack.push(a);
    // Remember the value handle to compute the subtree size on close.
    this.aggSize[a] = v;
    return v;
  }

  openList(): number {
    return this.openAggregate(Tag.List, -1);
  }

  openTyped(typeName: string): number {
    return this.openAggregate(Tag.Typed, this.nameTable.intern(typeName));
  }

  closeAggregate(): void {
    const a = this.openStack.pop();
    if (a === undefined) throw new Error("closeAggregate without open aggregate");
    const handle = this.aggSize[a]!;
    this.aggSize[a] = this.valueCount - handle - 1;
  }

  /** Stores the entity whose argument list was opened at `argsHandle`. */
  commitEntity(id: number, typeName: string, argsHandle: number, start: number, end: number): number {
    const k = this.entityCount;
    if (k >= this.entityIds.length) {
      this.entityIds = growU32(this.entityIds, k + 1);
      this.entityTypes = growU32(this.entityTypes, k + 1);
      this.entityArgs = growU32(this.entityArgs, k + 1);
      this.entityStart = growU32(this.entityStart, k + 1);
      this.entityEnd = growU32(this.entityEnd, k + 1);
    }
    this.entityIds[k] = id;
    this.entityTypes[k] = this.nameTable.intern(typeName);
    this.entityArgs[k] = argsHandle;
    this.entityStart[k] = Math.min(start, 0xffffffff);
    this.entityEnd[k] = Math.min(end, 0xffffffff);
    this.entityCount = k + 1;
    this.idMap!.set(id, k);
    if (id > this.maxId) this.maxId = id;
    return k;
  }

  hasId(id: number): boolean {
    return this.indexOfId(id) >= 0;
  }

  /** Builds lookup indexes and trims arena capacity. Call once after parsing. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const n = this.entityCount;
    const trim = <T extends Uint8Array<ArrayBuffer> | Int32Array<ArrayBuffer> | Uint32Array<ArrayBuffer> | Float64Array<ArrayBuffer>>(a: T, used: number): T =>
      (a.length > used * 1.25 + 64 ? (a.slice(0, used) as T) : a);
    this.tags = trim(this.tags, this.valueCount);
    this.payload = trim(this.payload, this.valueCount);
    this.reals = trim(this.reals, this.realCount);
    this.aggCount = trim(this.aggCount, this.aggTotal);
    this.aggSize = trim(this.aggSize, this.aggTotal);
    this.aggType = trim(this.aggType, this.aggTotal);
    this.entityIds = trim(this.entityIds, n);
    this.entityTypes = trim(this.entityTypes, n);
    this.entityArgs = trim(this.entityArgs, n);
    this.entityStart = trim(this.entityStart, n);
    this.entityEnd = trim(this.entityEnd, n);

    // Dense id table when ids are reasonably compact; hash map otherwise.
    if (this.maxId <= Math.max(1024, n * 4) && this.maxId < 1 << 28) {
      const dense = new Int32Array(this.maxId + 1).fill(-1);
      for (let k = 0; k < n; k++) dense[this.entityIds[k]!] = k;
      this.idDense = dense;
      this.idMap = null;
    }

    // Counting sort of entity indices by type.
    const typeCount = this.nameTable.names.length;
    const offsets = new Uint32Array(typeCount + 1);
    for (let k = 0; k < n; k++) offsets[this.entityTypes[k]! + 1]!++;
    for (let t = 0; t < typeCount; t++) offsets[t + 1]! += offsets[t]!;
    const cursor = offsets.slice(0, typeCount);
    const members = new Uint32Array(n);
    for (let k = 0; k < n; k++) members[cursor[this.entityTypes[k]!]!++] = k;
    this.typeOffsets = offsets;
    this.typeMembers = members;
  }

  // ================= query API =================

  indexOfId(id: number): number {
    if (this.idDense) return id >= 0 && id < this.idDense.length ? this.idDense[id]! : -1;
    return this.idMap!.get(id) ?? -1;
  }

  idAt(index: number): number {
    return this.entityIds[index]!;
  }

  typeIdAt(index: number): number {
    return this.entityTypes[index]!;
  }

  typeNameAt(index: number): string {
    return this.nameTable.names[this.entityTypes[index]!]!;
  }

  /** Upper-case type name for an instance name, or undefined when missing. */
  typeOf(id: number): string | undefined {
    const k = this.indexOfId(id);
    return k < 0 ? undefined : this.typeNameAt(k);
  }

  typeIdOf(name: string): number {
    return this.nameTable.lookup(name);
  }

  typeName(typeId: number): string {
    return this.nameTable.names[typeId] ?? "";
  }

  get typeNames(): readonly string[] {
    return this.nameTable.names;
  }

  /** Entity indices whose type is exactly `name` (upper case). */
  indicesOfType(name: string): Uint32Array {
    if (!this.typeOffsets || !this.typeMembers) throw new Error("StepStore.finalize() has not been called");
    const t = this.nameTable.lookup(name);
    if (t < 0) return new Uint32Array(0);
    return this.typeMembers.subarray(this.typeOffsets[t]!, this.typeOffsets[t + 1]!);
  }

  /** Instance names (#ids) of every entity of the given type. */
  idsOfType(name: string): number[] {
    const out: number[] = [];
    for (const k of this.indicesOfType(name)) out.push(this.entityIds[k]!);
    return out;
  }

  countOfType(name: string): number {
    return this.indicesOfType(name).length;
  }

  /** Handle of the argument list of entity `index`. */
  argsOf(index: number): number {
    return this.entityArgs[index]!;
  }

  // ---- value handles ----

  tag(v: number): Tag {
    return this.tags[v] as Tag;
  }

  isNull(v: number): boolean {
    const t = this.tags[v];
    return t === Tag.Null || t === Tag.Derived;
  }

  /** Number of direct children of an aggregate handle (0 for scalars). */
  count(v: number): number {
    const t = this.tags[v];
    return t === Tag.List || t === Tag.Typed ? this.aggCount[this.payload[v]!]! : 0;
  }

  /** Handle of the value following `v` at the same nesting level. */
  next(v: number): number {
    const t = this.tags[v];
    return t === Tag.List || t === Tag.Typed ? v + 1 + this.aggSize[this.payload[v]!]! : v + 1;
  }

  /** Handle of child `i` of aggregate `v`, or -1. O(i). */
  item(v: number, i: number): number {
    const n = this.count(v);
    if (i < 0 || i >= n) return -1;
    let h = v + 1;
    for (let k = 0; k < i; k++) h = this.next(h);
    return h;
  }

  /** Child handles of an aggregate. */
  items(v: number): number[] {
    const n = this.count(v);
    const out = new Array<number>(n);
    let h = v + 1;
    for (let k = 0; k < n; k++) {
      out[k] = h;
      h = this.next(h);
    }
    return out;
  }

  /** Argument `i` of entity `index`, or -1 when absent. */
  arg(index: number, i: number): number {
    return this.item(this.entityArgs[index]!, i);
  }

  argCount(index: number): number {
    return this.count(this.entityArgs[index]!);
  }

  /** Numeric value of an integer or real handle (NaN otherwise). */
  num(v: number): number {
    switch (this.tags[v]) {
      case Tag.Integer: return this.payload[v]!;
      case Tag.Real:
      case Tag.BigInteger: return this.reals[this.payload[v]!]!;
      case Tag.Typed: {
        // Typed measure such as IFCLENGTHMEASURE(2.5)
        if (this.aggCount[this.payload[v]!] === 1) return this.num(v + 1);
        return Number.NaN;
      }
      default: return Number.NaN;
    }
  }

  /** Referenced instance name, or -1. */
  ref(v: number): number {
    return this.tags[v] === Tag.Ref ? this.payload[v]! : -1;
  }

  /** String value, or undefined. Typed wrappers such as IFCLABEL('x') are unwrapped. */
  str(v: number): string | undefined {
    const t = this.tags[v];
    if (t === Tag.String) return this.strings[this.payload[v]!];
    if (t === Tag.Typed && this.aggCount[this.payload[v]!] === 1) return this.str(v + 1);
    return undefined;
  }

  /** Enumeration name (upper case, without dots), or undefined. */
  enumName(v: number): string | undefined {
    const t = this.tags[v];
    if (t === Tag.Enum) return this.enumTable.names[this.payload[v]!];
    if (t === Tag.Typed && this.aggCount[this.payload[v]!] === 1) return this.enumName(v + 1);
    return undefined;
  }

  /** Logical value of `.T.`/`.F.`/`.U.` enumerations. */
  bool(v: number): boolean | undefined {
    const e = this.enumName(v);
    if (e === "T" || e === "TRUE") return true;
    if (e === "F" || e === "FALSE") return false;
    return undefined;
  }

  /** Type name of a typed value handle, or undefined. */
  typedName(v: number): string | undefined {
    return this.tags[v] === Tag.Typed ? this.nameTable.names[this.aggType[this.payload[v]!]!] : undefined;
  }

  /**
   * Reads an aggregate of numbers into a Float64Array. Returns undefined when
   * any member is not numeric.
   */
  numbers(v: number): Float64Array | undefined {
    const n = this.count(v);
    if (this.tags[v] !== Tag.List) return undefined;
    const out = new Float64Array(n);
    let h = v + 1;
    for (let k = 0; k < n; k++) {
      const x = this.num(h);
      if (Number.isNaN(x)) return undefined;
      out[k] = x;
      h = this.next(h);
    }
    return out;
  }

  /**
   * Reads a list of equally sized numeric lists (e.g. a coordinate list) into
   * a flat Float64Array with the given stride. Short rows are zero-padded
   * (2D points in 3D context); returns undefined on non-numeric content.
   */
  numberRows(v: number, stride: number): Float64Array | undefined {
    if (this.tags[v] !== Tag.List) return undefined;
    const rows = this.count(v);
    const out = new Float64Array(rows * stride);
    let h = v + 1;
    for (let r = 0; r < rows; r++) {
      if (this.tags[h] !== Tag.List) return undefined;
      const m = this.count(h);
      let c = h + 1;
      for (let k = 0; k < m && k < stride; k++) {
        const x = this.num(c);
        if (Number.isNaN(x)) return undefined;
        out[r * stride + k] = x;
        c = this.next(c);
      }
      h = this.next(h);
    }
    return out;
  }

  /** Like numberRows but returns rows of varying length (for index lists). */
  intRows(v: number): Int32Array[] | undefined {
    if (this.tags[v] !== Tag.List) return undefined;
    const rows = this.count(v);
    const out: Int32Array[] = new Array(rows);
    let h = v + 1;
    for (let r = 0; r < rows; r++) {
      const inner = this.tags[h] === Tag.Typed ? h + 1 : h;
      if (this.tags[inner] !== Tag.List) return undefined;
      const m = this.count(inner);
      const row = new Int32Array(m);
      let c = inner + 1;
      for (let k = 0; k < m; k++) {
        const x = this.num(c);
        if (!Number.isFinite(x)) return undefined;
        row[k] = Math.trunc(x);
        c = this.next(c);
      }
      out[r] = row;
      h = this.next(h);
    }
    return out;
  }

  /** Reference ids contained in a list handle (non-references skipped). */
  refs(v: number): number[] {
    const out: number[] = [];
    const t = this.tags[v];
    if (t === Tag.Ref) {
      out.push(this.payload[v]!);
      return out;
    }
    if (t !== Tag.List && t !== Tag.Typed) return out;
    const n = this.count(v);
    let h = v + 1;
    for (let k = 0; k < n; k++) {
      const tt = this.tags[h];
      if (tt === Tag.Ref) out.push(this.payload[h]!);
      else if (tt === Tag.List || tt === Tag.Typed) out.push(...this.refs(h));
      h = this.next(h);
    }
    return out;
  }

  /** Materialises a value handle into plain objects. */
  value(v: number): StepValue {
    switch (this.tags[v]) {
      case Tag.Null: return { kind: "null" };
      case Tag.Derived: return { kind: "derived" };
      case Tag.Integer: return { kind: "integer", value: this.payload[v]! };
      case Tag.BigInteger: return { kind: "integer", value: this.reals[this.payload[v]!]! };
      case Tag.Real: return { kind: "real", value: this.reals[this.payload[v]!]! };
      case Tag.String: return { kind: "string", value: this.strings[this.payload[v]!]! };
      case Tag.Binary: return { kind: "binary", value: this.strings[this.payload[v]!]! };
      case Tag.Enum: return { kind: "enum", value: this.enumTable.names[this.payload[v]!]! };
      case Tag.Ref: return { kind: "ref", id: this.payload[v]! };
      case Tag.List: return { kind: "list", values: this.items(v).map((h) => this.value(h)) };
      case Tag.Typed:
        return {
          kind: "typed",
          type: this.nameTable.names[this.aggType[this.payload[v]!]!]!,
          args: this.items(v).map((h) => this.value(h)),
        };
      default:
        throw new Error(`corrupt value tag ${this.tags[v]} at handle ${v}`);
    }
  }

  /** Materialised arguments of an entity. */
  argsValue(index: number): StepValue[] {
    return this.items(this.entityArgs[index]!).map((h) => this.value(h));
  }

  /** Approximate retained memory in bytes (arena + indexes). */
  get byteSize(): number {
    let s = this.tags.byteLength + this.payload.byteLength + this.reals.byteLength;
    s += this.aggCount.byteLength + this.aggSize.byteLength + this.aggType.byteLength;
    s += this.entityIds.byteLength * 5;
    if (this.idDense) s += this.idDense.byteLength;
    for (const str of this.strings) s += 16 + str.length * 2;
    return s;
  }
}
