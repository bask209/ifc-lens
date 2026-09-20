// SPDX-License-Identifier: Apache-2.0
/**
 * Byte sources for the loader: URL (fetch streaming), Blob/File (stream) and
 * ArrayBuffer (chunked). ifcZIP archives are detected by signature and the
 * first .ifc member is inflated with the platform DecompressionStream.
 */

import { IfcResourceLimitError } from "../diagnostics.ts";
import type { LoadSourceDescriptor } from "../protocol/messages.ts";

export interface OpenedSource {
  stream: ReadableStream<Uint8Array>;
  /** Total bytes when known (uncompressed size for archives). */
  total: number | undefined;
  name: string;
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

const CHUNK = 1 << 20;

export function bufferStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + CHUNK);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

export function validateSourceUrl(url: string, base?: string): URL {
  let parsed: URL;
  try {
    parsed = base ? new URL(url, base) : new URL(url);
  } catch {
    throw new SourceError(`Invalid IFC URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "blob:") {
    throw new SourceError(`Unsupported IFC URL scheme: ${parsed.protocol}`);
  }
  return parsed;
}

function isZip(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * Extracts the first `.ifc` member of a ZIP archive (stored or deflated).
 * Uses the central directory so data descriptors are handled.
 */
export function openZipMember(archive: Uint8Array, maxBytes: number): OpenedSource {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  // End of central directory record (search backwards, max comment 64 KiB)
  let eocd = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SourceError("ifcZIP: end of central directory not found");
  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let e = 0; e < entries; e++) {
    if (p + 46 > archive.length || view.getUint32(p, true) !== 0x02014b50) throw new SourceError("ifcZIP: corrupt central directory");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(archive.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (!/\.ifc$/i.test(name)) continue;
    if (uncompressedSize > maxBytes) {
      throw new IfcResourceLimitError({ resource: "file-bytes", actual: uncompressedSize, limit: maxBytes });
    }
    if (localOffset + 30 > archive.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new SourceError("ifcZIP: corrupt local header");
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) throw new SourceError("ifcZIP: truncated member data");
    if (method === 0) return { stream: bufferStream(data), total: data.length, name };
    if (method !== 8) throw new SourceError(`ifcZIP: unsupported compression method ${method}`);
    if (typeof DecompressionStream === "undefined") throw new SourceError("ifcZIP: DecompressionStream is not available in this environment");
    const inflated = bufferStream(data).pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    return { stream: inflated, total: uncompressedSize, name };
  }
  throw new SourceError("ifcZIP archive contains no .ifc file");
}

async function fromBytes(bytes: Uint8Array, name: string, maxBytes: number): Promise<OpenedSource> {
  if (isZip(bytes)) return openZipMember(bytes, maxBytes);
  if (bytes.length > maxBytes) throw new IfcResourceLimitError({ resource: "file-bytes", actual: bytes.length, limit: maxBytes });
  return { stream: bufferStream(bytes), total: bytes.length, name };
}

/** Opens a load source; fetch/stream errors are converted to explanatory SourceErrors. */
export async function openSource(source: LoadSourceDescriptor, maxBytes: number, signal?: AbortSignal): Promise<OpenedSource> {
  switch (source.kind) {
    case "buffer":
      return fromBytes(new Uint8Array(source.buffer), source.name, maxBytes);
    case "blob": {
      if (source.blob.size > maxBytes && !/\.ifczip$/i.test(source.name)) {
        throw new IfcResourceLimitError({ resource: "file-bytes", actual: source.blob.size, limit: maxBytes });
      }
      const head = new Uint8Array(await source.blob.slice(0, 4).arrayBuffer());
      if (isZip(head)) return openZipMember(new Uint8Array(await source.blob.arrayBuffer()), maxBytes);
      return { stream: source.blob.stream() as ReadableStream<Uint8Array>, total: source.blob.size, name: source.name };
    }
    case "url": {
      const url = validateSourceUrl(source.url);
      let response: Response;
      try {
        response = await fetch(url.href, { credentials: source.credentials, ...(signal ? { signal } : {}) });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        throw new SourceError(
          `Network or CORS error while fetching ${url.href}. Cross-origin IFC files must be served with an Access-Control-Allow-Origin header${source.credentials === "include" ? " that names this origin and Access-Control-Allow-Credentials: true" : ""}. (${e instanceof Error ? e.message : String(e)})`,
        );
      }
      if (!response.ok) throw new SourceError(`HTTP ${response.status} ${response.statusText} while fetching ${url.href}`);
      const length = Number(response.headers.get("content-length"));
      const encoded = response.headers.get("content-encoding");
      const total = Number.isFinite(length) && length > 0 && !encoded ? length : undefined;
      if (total !== undefined && total > maxBytes && !/\.ifczip$/i.test(url.pathname)) {
        await response.body?.cancel().catch(() => undefined);
        throw new IfcResourceLimitError({ resource: "file-bytes", actual: total, limit: maxBytes });
      }
      const name = decodeURIComponent(url.pathname.split("/").pop() ?? "model.ifc");
      const type = response.headers.get("content-type") ?? "";
      if (/\.ifczip$/i.test(url.pathname) || /zip/i.test(type) || !response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return fromBytes(bytes, name, maxBytes);
      }
      return { stream: response.body, total, name };
    }
  }
}
