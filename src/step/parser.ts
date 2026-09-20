// SPDX-License-Identifier: Apache-2.0
/**
 * ISO 10303-21 Physical File parser. Consumes tokens from the streaming
 * tokenizer and writes entity instances straight into a packed StepStore.
 *
 * The value grammar is handled iteratively with an explicit nesting counter,
 * so hostile nesting cannot exhaust the call stack. Syntax errors inside an
 * instance roll the instance back, emit a diagnostic and resynchronise at the
 * next `;`.
 */

import { AbortError, DiagnosticLog, IfcResourceLimitError, StepFormatError } from "../diagnostics.ts";
import { decodeStepString } from "./step-string.ts";
import { StepStore, emptyHeader, type StepHeader, type StepValue } from "./store.ts";
import { StepTokenizer, TokenKind, TOKEN_KIND_NAMES, type StepToken, type TokenizerLimits } from "./tokenizer.ts";

export interface StepParseLimits extends TokenizerLimits {
  maxEntities: number;
  maxAggregateDepth: number;
  maxFileBytes: number;
}

export const DEFAULT_PARSE_LIMITS: StepParseLimits = {
  maxTokenBytes: 4096,
  maxStringBytes: 16 * 1024 * 1024,
  maxEntities: 20_000_000,
  maxAggregateDepth: 64,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
};

export interface StepParseOptions {
  limits?: Partial<StepParseLimits>;
  diagnostics?: DiagnosticLog;
  signal?: AbortSignal;
  /** Called with the number of bytes consumed after each chunk. */
  onProgress?: (bytesRead: number) => void;
}

const S = {
  Start: 0,
  AfterIsoKeyword: 1,
  Section: 2,
  AfterSectionKeyword: 3,
  HeaderEntity: 4,
  HeaderOpen: 5,
  DataParams: 6,
  ExpectId: 7,
  ExpectEquals: 8,
  ExpectType: 9,
  ExpectOpen: 10,
  Values: 11,
  AfterValue: 12,
  TypedOpen: 13,
  ExpectSemicolon: 14,
  Complex: 15,
  ComplexOpen: 16,
  Recover: 17,
  End: 18,
} as const;
type ParserState = (typeof S)[keyof typeof S];

type Section = "none" | "header" | "data";

export class StepParser {
  readonly store: StepStore;
  readonly diagnostics: DiagnosticLog;
  readonly header: StepHeader = emptyHeader();
  private readonly tokenizer: StepTokenizer;
  private readonly limits: StepParseLimits;
  private state: ParserState = S.Start;
  private section: Section = "none";
  private sawIsoKeyword = false;
  private sawEnd = false;
  private dataSections = 0;

  // current instance
  private id = 0;
  private typeName = "";
  private argsHandle = 0;
  private instanceStart = 0;
  private depth = 0;
  private headerEntity = "";
  private complexParts: string[] = [];
  private complexDepth = 0;
  private duplicate = false;
  /** True between beginEntity() and commit/rollback of the current statement. */
  private inInstance = false;
  /** True right after an aggregate was opened (so ')' closes an empty aggregate). */
  private justOpened = false;
  private statementAfterRecover: ParserState = S.ExpectId;
  private readonly onToken: (t: StepToken) => void;

  constructor(store: StepStore = new StepStore(), options: StepParseOptions = {}) {
    this.store = store;
    this.limits = { ...DEFAULT_PARSE_LIMITS, ...options.limits };
    this.diagnostics = options.diagnostics ?? new DiagnosticLog();
    this.tokenizer = new StepTokenizer(this.limits);
    this.onToken = (t) => this.token(t);
  }

  get bytesRead(): number {
    return this.tokenizer.bytesConsumed;
  }

  push(chunk: Uint8Array): void {
    if (this.tokenizer.bytesConsumed + chunk.length > this.limits.maxFileBytes) {
      throw new IfcResourceLimitError({
        resource: "file-bytes",
        actual: this.tokenizer.bytesConsumed + chunk.length,
        limit: this.limits.maxFileBytes,
      });
    }
    this.tokenizer.push(chunk, false, this.onToken);
  }

  /** Completes parsing, validates the envelope and finalises the store. */
  finish(): StepStore {
    this.tokenizer.push(new Uint8Array(0), true, this.onToken);
    if (this.state !== S.End && this.state !== S.Section && this.state !== S.ExpectId) {
      this.diag(`unexpected end of input (${this.describeState()})`, this.bytesRead);
      this.rollback();
    }
    if (!this.sawIsoKeyword && this.store.entityCount === 0) {
      throw new StepFormatError("Not an ISO 10303-21 file: missing 'ISO-10303-21;' header and no entity instances");
    }
    if (this.dataSections === 0) {
      throw new StepFormatError("No DATA section found");
    }
    if (!this.sawEnd) this.diag("missing 'END-ISO-10303-21;'", this.bytesRead, "warning");
    this.store.header = this.header;
    this.store.finalize();
    return this.store;
  }

  private describeState(): string {
    switch (this.state) {
      case S.Values:
      case S.AfterValue:
      case S.TypedOpen:
        return `inside instance #${this.id}`;
      case S.HeaderEntity:
      case S.HeaderOpen:
        return "inside HEADER";
      default:
        return `state ${this.state}`;
    }
  }

  private diag(message: string, offset: number, severity: "error" | "warning" = "error"): void {
    this.diagnostics.add({ code: "STEP_SYNTAX", severity, message, offset });
  }

  private syntaxError(t: StepToken, expected: string): void {
    const got = t.kind === TokenKind.Invalid ? t.text : TOKEN_KIND_NAMES[t.kind]! + (t.kind === TokenKind.Keyword ? ` '${t.text}'` : "");
    const where = this.section === "data" && this.id > 0 ? ` in #${this.id}` : "";
    this.diag(`expected ${expected}, found ${got}${where}`, t.start);
    this.rollback();
    this.statementAfterRecover = this.section === "header" ? S.HeaderEntity : S.ExpectId;
    this.state = t.kind === TokenKind.Semicolon ? this.statementAfterRecover : S.Recover;
  }

  private rollback(): void {
    if (this.inInstance) {
      this.store.rollbackEntity();
      this.inInstance = false;
    }
  }

  private token(t: StepToken): void {
    switch (this.state) {
      case S.Start:
        if (t.kind === TokenKind.Keyword && t.text === "ISO-10303-21") {
          this.sawIsoKeyword = true;
          this.state = S.AfterIsoKeyword;
          return;
        }
        if (t.kind === TokenKind.Keyword && (t.text === "HEADER" || t.text === "DATA")) {
          this.diag("missing 'ISO-10303-21;' header", t.start, "warning");
          this.state = S.Section;
          this.token(t);
          return;
        }
        throw new StepFormatError("Not an ISO 10303-21 file: expected 'ISO-10303-21;'", t.start);
      case S.AfterIsoKeyword:
        if (t.kind !== TokenKind.Semicolon) this.diag("expected ';' after ISO-10303-21", t.start);
        this.state = S.Section;
        if (t.kind !== TokenKind.Semicolon) this.token(t);
        return;
      case S.Section:
        if (t.kind === TokenKind.Keyword) {
          if (t.text === "HEADER") {
            this.section = "header";
            this.state = S.AfterSectionKeyword;
            return;
          }
          if (t.text === "DATA") {
            this.section = "data";
            this.dataSections++;
            this.state = S.AfterSectionKeyword;
            return;
          }
          if (t.text === "END-ISO-10303-21") {
            this.sawEnd = true;
            this.state = S.End;
            return;
          }
        }
        this.diag(`expected section keyword, found ${TOKEN_KIND_NAMES[t.kind]}`, t.start);
        this.state = S.Recover;
        this.statementAfterRecover = S.Section;
        return;
      case S.AfterSectionKeyword:
        if (t.kind === TokenKind.Semicolon) {
          this.state = this.section === "header" ? S.HeaderEntity : S.ExpectId;
          return;
        }
        if (t.kind === TokenKind.OpenParen && this.section === "data") {
          // DATA('name', ('SCHEMA')); — edition 3 named data section.
          this.state = S.DataParams;
          this.depth = 1;
          return;
        }
        this.diag("expected ';' after section keyword", t.start);
        this.state = this.section === "header" ? S.HeaderEntity : S.ExpectId;
        this.token(t);
        return;
      case S.DataParams:
        if (t.kind === TokenKind.OpenParen) this.depth++;
        else if (t.kind === TokenKind.CloseParen) this.depth--;
        if (this.depth === 0) this.state = S.AfterSectionKeyword;
        return;
      case S.HeaderEntity:
        if (t.kind === TokenKind.Keyword) {
          if (t.text === "ENDSEC") {
            this.state = S.ExpectSemicolon;
            this.section = "none";
            return;
          }
          this.headerEntity = t.text;
          this.state = S.HeaderOpen;
          return;
        }
        this.syntaxError(t, "header entity");
        return;
      case S.HeaderOpen:
        if (t.kind !== TokenKind.OpenParen) {
          this.syntaxError(t, "'('");
          return;
        }
        this.store.beginEntity();
        this.inInstance = true;
        this.argsHandle = this.store.openList();
        this.depth = 1;
        this.id = 0;
        this.justOpened = true;
        this.state = S.Values;
        return;
      case S.ExpectSemicolon:
        if (t.kind !== TokenKind.Semicolon) {
          this.diag("expected ';'", t.start);
          this.state = this.section === "none" ? S.Section : S.ExpectId;
          this.token(t);
          return;
        }
        if (this.section === "none") {
          this.state = S.Section;
          return;
        }
        this.commit(t.end);
        return;
      case S.ExpectId:
        if (t.kind === TokenKind.HashId) {
          this.id = t.num;
          this.instanceStart = t.start;
          this.state = S.ExpectEquals;
          return;
        }
        if (t.kind === TokenKind.Keyword && t.text === "ENDSEC") {
          this.section = "none";
          this.state = S.ExpectSemicolon;
          return;
        }
        this.syntaxError(t, "instance name '#n' or ENDSEC");
        return;
      case S.ExpectEquals:
        if (t.kind !== TokenKind.Equals) {
          this.syntaxError(t, "'='");
          return;
        }
        this.state = S.ExpectType;
        return;
      case S.ExpectType:
        if (t.kind === TokenKind.Keyword) {
          this.typeName = t.text;
          this.state = S.ExpectOpen;
          return;
        }
        if (t.kind === TokenKind.OpenParen) {
          // Complex (external mapping) instance: #1=(A(...)B(...));
          this.beginInstance();
          this.complexParts = [];
          this.argsHandle = this.store.openList();
          this.depth = 1;
          this.complexDepth = 1;
          this.state = S.Complex;
          return;
        }
        this.syntaxError(t, "entity type name");
        return;
      case S.ExpectOpen:
        if (t.kind !== TokenKind.OpenParen) {
          this.syntaxError(t, "'('");
          return;
        }
        this.beginInstance();
        this.argsHandle = this.store.openList();
        this.depth = 1;
        this.complexDepth = 0;
        this.justOpened = true;
        this.state = S.Values;
        return;
      case S.Complex:
        if (t.kind === TokenKind.Keyword) {
          this.complexParts.push(t.text);
          this.store.openTyped(t.text);
          this.depth++;
          this.state = S.ComplexOpen;
          return;
        }
        if (t.kind === TokenKind.CloseParen) {
          this.store.closeAggregate();
          this.depth--;
          this.typeName = this.complexParts.join("+");
          this.state = S.ExpectSemicolon;
          return;
        }
        this.syntaxError(t, "entity type name in complex instance");
        return;
      case S.ComplexOpen:
        if (t.kind !== TokenKind.OpenParen) {
          this.syntaxError(t, "'('");
          return;
        }
        this.justOpened = true;
        this.state = S.Values;
        return;
      case S.Values:
        this.value(t);
        return;
      case S.AfterValue:
        if (t.kind === TokenKind.Comma) {
          this.justOpened = false;
          this.state = S.Values;
          return;
        }
        if (t.kind === TokenKind.CloseParen) {
          this.close();
          return;
        }
        this.syntaxError(t, "',' or ')'");
        return;
      case S.TypedOpen:
        if (t.kind !== TokenKind.OpenParen) {
          this.syntaxError(t, "'(' after typed parameter name");
          return;
        }
        this.justOpened = true;
        this.state = S.Values;
        return;
      case S.Recover:
        if (t.kind === TokenKind.Semicolon) this.state = this.statementAfterRecover;
        return;
      case S.End:
        // Trailing content after END-ISO-10303-21; is ignored (signatures etc.).
        return;
    }
  }

  private beginInstance(): void {
    this.store.beginEntity();
    this.inInstance = true;
    this.duplicate = this.store.hasId(this.id);
    if (this.store.entityCount >= this.limits.maxEntities) {
      throw new IfcResourceLimitError({
        resource: "entities",
        actual: this.store.entityCount + 1,
        limit: this.limits.maxEntities,
      });
    }
  }

  private value(t: StepToken): void {
    const store = this.store;
    switch (t.kind) {
      case TokenKind.Dollar: store.addNull(); break;
      case TokenKind.Asterisk: store.addDerived(); break;
      case TokenKind.Integer: store.addInteger(t.num); break;
      case TokenKind.Real: store.addReal(t.num); break;
      case TokenKind.HashId:
        if (t.num > 0x7fffffff) {
          this.syntaxError(t, "reference within 1..2^31-1");
          return;
        }
        store.addRef(t.num);
        break;
      case TokenKind.String:
        store.addString(
          decodeStepString(t.bytes, t.offset, t.offset + t.length, (message) =>
            this.diagnostics.add({ code: "STEP_UNSUPPORTED_ENCODING", severity: "warning", message, offset: t.start, entityId: this.id || undefined }),
          ),
        );
        break;
      case TokenKind.Enumeration: store.addEnum(t.text); break;
      case TokenKind.Binary: store.addBinary(t.text); break;
      case TokenKind.OpenParen:
        if (!this.enter(t)) return;
        store.openList();
        this.justOpened = true;
        return; // stay in Values (empty list or first element)
      case TokenKind.Keyword:
        if (!this.enter(t)) return;
        store.openTyped(t.text);
        this.state = S.TypedOpen;
        return;
      case TokenKind.CloseParen:
        // Legal only directly after '(' (empty aggregate).
        if (this.justOpened) {
          this.close();
          return;
        }
        this.syntaxError(t, "value");
        return;
      default:
        this.syntaxError(t, "value");
        return;
    }
    this.state = S.AfterValue;
  }

  private enter(t: StepToken): boolean {
    this.depth++;
    if (this.depth > this.limits.maxAggregateDepth) {
      this.diagnostics.add({
        code: "RESOURCE_LIMIT",
        severity: "error",
        message: `aggregate nesting exceeds maxAggregateDepth (${this.limits.maxAggregateDepth})`,
        offset: t.start,
        entityId: this.id || undefined,
      });
      this.rollback();
      this.statementAfterRecover = this.section === "header" ? S.HeaderEntity : S.ExpectId;
      this.state = S.Recover;
      return false;
    }
    return true;
  }

  private close(): void {
    this.justOpened = false;
    this.store.closeAggregate();
    this.depth--;
    if (this.depth === 0) {
      this.state = S.ExpectSemicolon;
    } else if (this.complexDepth > 0 && this.depth === this.complexDepth) {
      this.state = S.Complex;
    } else {
      this.state = S.AfterValue;
    }
  }

  private commit(end: number): void {
    if (this.section === "header") {
      const args = this.store.value(this.argsHandle);
      this.rollback();
      if (args.kind === "list") this.applyHeader(this.headerEntity, args.values);
      this.state = S.HeaderEntity;
      return;
    }
    if (this.duplicate) {
      this.diagnostics.add({
        code: "STEP_DUPLICATE_ID",
        severity: "error",
        message: `duplicate instance name #${this.id}; later definition ignored`,
        entityId: this.id,
        offset: this.instanceStart,
      });
      this.rollback();
    } else {
      this.store.commitEntity(this.id, this.typeName, this.argsHandle, this.instanceStart, end);
      this.inInstance = false;
    }
    this.id = 0;
    this.state = S.ExpectId;
  }

  private applyHeader(name: string, args: StepValue[]): void {
    const text = (v: StepValue | undefined): string => (v && v.kind === "string" ? v.value : "");
    const texts = (v: StepValue | undefined): string[] =>
      v && v.kind === "list" ? v.values.map(text) : v && v.kind === "string" ? [v.value] : [];
    const h = this.header;
    switch (name) {
      case "FILE_DESCRIPTION":
        h.fileDescription = texts(args[0]);
        h.implementationLevel = text(args[1]);
        break;
      case "FILE_NAME":
        h.fileName = text(args[0]);
        h.timeStamp = text(args[1]);
        h.author = texts(args[2]);
        h.organization = texts(args[3]);
        h.preprocessorVersion = text(args[4]);
        h.originatingSystem = text(args[5]);
        h.authorization = text(args[6]);
        break;
      case "FILE_SCHEMA":
        h.schemaIdentifiers = texts(args[0]);
        break;
      default:
        break;
    }
  }
}

/** Parses a complete in-memory STEP file. */
export function parseStepBytes(bytes: Uint8Array, options: StepParseOptions = {}): StepParser {
  const parser = new StepParser(new StepStore(), options);
  const CHUNK = 1 << 20;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    if (options.signal?.aborted) throw new AbortError();
    parser.push(bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
    options.onProgress?.(parser.bytesRead);
  }
  parser.finish();
  return parser;
}

/** Parses a STEP file from a byte stream without materialising the whole file. */
export async function parseStepStream(
  stream: ReadableStream<Uint8Array>,
  options: StepParseOptions = {},
): Promise<StepParser> {
  const parser = new StepParser(new StepStore(), options);
  const reader = stream.getReader();
  try {
    for (;;) {
      if (options.signal?.aborted) throw new AbortError();
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
      options.onProgress?.(parser.bytesRead);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  } finally {
    reader.releaseLock();
  }
  parser.finish();
  return parser;
}

/** Parses STEP text (tests / small inputs). */
export function parseStepText(text: string, options: StepParseOptions = {}): StepParser {
  return parseStepBytes(new TextEncoder().encode(text), options);
}
