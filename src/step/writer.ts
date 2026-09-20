// SPDX-License-Identifier: Apache-2.0
/** Serialises StepValues back to ISO 10303-21 text. */

import { encodeStepString } from "./step-string.ts";
import type { StepValue } from "./store.ts";

/** Formats a real so that it re-parses as a STEP REAL (always has a '.'). */
export function formatReal(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`cannot serialise non-finite real ${x}`);
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return `${x}.`;
  const s = String(x).toUpperCase();
  if (s.includes("E")) {
    const [mantissa, exponent] = s.split("E");
    return `${mantissa!.includes(".") ? mantissa : `${mantissa}.`}E${exponent}`;
  }
  return s;
}

export function serializeValue(v: StepValue): string {
  switch (v.kind) {
    case "null": return "$";
    case "derived": return "*";
    case "integer": return String(Math.trunc(v.value));
    case "real": return formatReal(v.value);
    case "string": return `'${encodeStepString(v.value)}'`;
    case "enum": return `.${v.value}.`;
    case "ref": return `#${v.id}`;
    case "binary": return `"${v.value}"`;
    case "list": return `(${v.values.map(serializeValue).join(",")})`;
    case "typed": return `${v.type}(${v.args.map(serializeValue).join(",")})`;
  }
}

export function serializeEntity(id: number, type: string, args: readonly StepValue[]): string {
  return `#${id}=${type}(${args.map(serializeValue).join(",")});`;
}
