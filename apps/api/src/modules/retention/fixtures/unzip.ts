// SPDX-License-Identifier: AGPL-3.0-only
// A small ZIP reader for tests: the central directory (ZIP64 included), each entry inflated and its
// CRC checked, so a test reads what the writer wrote the way an unzip tool would.
import { crc32, inflateRawSync } from "node:zlib";

const MAX32 = 0xffffffff;

export function unzip(zip: Buffer): Map<string, Buffer> {
  let eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error("unzip: no end record");
  let count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (at === MAX32) {
    const record = Number(zip.readBigUInt64LE(eocd - 20 + 8));
    if (zip.readUInt32LE(record) !== 0x06064b50) throw new Error("unzip: no ZIP64 end record");
    count = Number(zip.readBigUInt64LE(record + 32));
    at = Number(zip.readBigUInt64LE(record + 48));
  }
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("unzip: bad central header");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    let compressed = zip.readUInt32LE(at + 20);
    let size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    let offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (offset === MAX32) {
      const extra = at + 46 + nameLength;
      if (zip.readUInt16LE(extra) !== 1) throw new Error("unzip: no ZIP64 extra");
      size = Number(zip.readBigUInt64LE(extra + 4));
      compressed = Number(zip.readBigUInt64LE(extra + 12));
      offset = Number(zip.readBigUInt64LE(extra + 20));
    }
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(start, start + compressed);
    const body = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (body.length !== size || crc32(body) !== crc) throw new Error(`unzip: ${name} does not match its size or CRC`);
    out.set(name, body);
    at += 46 + nameLength + extraLength + zip.readUInt16LE(at + 32);
  }
  return out;
}
