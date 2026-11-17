// SPDX-License-Identifier: AGPL-3.0-only
// A streaming ZIP writer on node:zlib, so an export needs no archive library: each entry's bytes go
// out as they come, with its CRC and sizes after it in a data descriptor, and ZIP64 records once an
// entry, an offset or the count passes what 32 bits hold. JSON is deflated batch by batch (each batch
// sync-flushed, the run ended by an empty final block); media files, already compressed, are stored.
import { constants, crc32, deflateRawSync } from "node:zlib";

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** An empty fixed-Huffman block with BFINAL set: ends a run of sync-flushed deflate blocks. */
const FINAL_BLOCK = Uint8Array.of(0x03, 0x00);
/** Data descriptor follows (bit 3); the name is UTF-8 (bit 11). */
const FLAGS = 0x0808;

type Done = { name: Buffer; method: number; crc: number; compressed: number; size: number; offset: number };

/** A DOS date and time, in the server's local time as ZIP readers expect. */
function dos(d: Date): [time: number, date: number] {
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}

export type ZipEntry = { write(chunk: Uint8Array): Promise<void>; end(): Promise<void> };

/**
 * Writes a ZIP to `out`, one entry at a time. `limit` is where ZIP64 starts; only tests lower it.
 * Returns the bytes written by `end`.
 */
export function createZip(out: (bytes: Uint8Array) => Promise<unknown>, now: Date, limit = MAX32) {
  const done: Done[] = [];
  let at = 0;
  const put = async (b: Uint8Array) => {
    await out(b);
    at += b.length;
  };
  const [time, date] = dos(now);
  const wide = (e: Done) => e.size >= limit || e.compressed >= limit;

  function entry(path: string, deflate: boolean): ZipEntry {
    const e: Done = { name: Buffer.from(path, "utf8"), method: deflate ? 8 : 0, crc: 0, compressed: 0, size: 0, offset: at };
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(45, 4);
    head.writeUInt16LE(FLAGS, 6);
    head.writeUInt16LE(e.method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    // CRC and sizes stay zero here: the data descriptor carries them.
    head.writeUInt16LE(e.name.length, 26);
    let started: Promise<void> | undefined;
    const start = () => (started ??= put(Buffer.concat([head, e.name])));
    return {
      async write(chunk) {
        await start();
        if (!chunk.length) return;
        e.crc = crc32(chunk, e.crc);
        e.size += chunk.length;
        const body = deflate ? deflateRawSync(chunk, { finishFlush: constants.Z_SYNC_FLUSH }) : chunk;
        e.compressed += body.length;
        await put(body);
      },
      async end() {
        await start();
        if (deflate) {
          e.compressed += FINAL_BLOCK.length;
          await put(FINAL_BLOCK);
        }
        const d = Buffer.alloc(wide(e) ? 24 : 16);
        d.writeUInt32LE(0x08074b50, 0);
        d.writeUInt32LE(e.crc, 4);
        if (wide(e)) {
          d.writeBigUInt64LE(BigInt(e.compressed), 8);
          d.writeBigUInt64LE(BigInt(e.size), 16);
        } else {
          d.writeUInt32LE(e.compressed, 8);
          d.writeUInt32LE(e.size, 12);
        }
        await put(d);
        done.push(e);
      },
    };
  }

  /** Writes a whole entry from one buffer. */
  async function file(path: string, body: Uint8Array, deflate = true): Promise<void> {
    const e = entry(path, deflate);
    await e.write(body);
    await e.end();
  }

  async function end(): Promise<number> {
    const cdStart = at;
    for (const e of done) {
      const big = wide(e) || e.offset >= limit;
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(45, 4);
      h.writeUInt16LE(big ? 45 : 20, 6);
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(big ? MAX32 : e.compressed, 20);
      h.writeUInt32LE(big ? MAX32 : e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(big ? 28 : 0, 30);
      h.writeUInt32LE(big ? MAX32 : e.offset, 42);
      const extra = Buffer.alloc(big ? 28 : 0);
      if (big) {
        // ZIP64 extended information: the sizes and the offset the header marked as too large.
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.size), 4);
        extra.writeBigUInt64LE(BigInt(e.compressed), 12);
        extra.writeBigUInt64LE(BigInt(e.offset), 20);
      }
      await put(Buffer.concat([h, e.name, extra]));
    }
    const cdSize = at - cdStart;
    const count = done.length;
    const big = count >= Math.min(MAX16, limit) || cdStart >= limit || cdSize >= limit;
    if (big) {
      const record = at;
      const z = Buffer.alloc(76);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(count), 24);
      z.writeBigUInt64LE(BigInt(count), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      // The locator, pointing back at the record.
      z.writeUInt32LE(0x07064b50, 56);
      z.writeBigUInt64LE(BigInt(record), 64);
      z.writeUInt32LE(1, 72);
      await put(z);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(big ? MAX16 : count, 8);
    eocd.writeUInt16LE(big ? MAX16 : count, 10);
    eocd.writeUInt32LE(big ? MAX32 : cdSize, 12);
    eocd.writeUInt32LE(big ? MAX32 : cdStart, 16);
    await put(eocd);
    return at;
  }

  return { entry, file, end };
}
