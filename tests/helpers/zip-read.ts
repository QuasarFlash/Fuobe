import zlib from "node:zlib";

/**
 * A strict ZIP reader for tests, written apart from the app's zip code so a test of a writer doesn't read its
 * output back with the same assumptions. Like Python's zipfile + testzip(): the end record, the central directory
 * and every local header must agree, stored and deflated entries are unpacked, and each entry's CRC-32 and size
 * must match. Any mismatch throws, naming the entry. ZIP64 end records are followed.
 */
export interface ZipInfo {
  filename: string;
  file_size: number;
  data: Buffer;
}

export interface ZipArchive {
  infolist(): ZipInfo[];
  namelist(): string[];
  read(name: string): Buffer;
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(buf: Buffer | Uint8Array): ZipArchive {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === EOCD && i + 22 + b.readUInt16LE(i + 20) === b.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end of central directory record");
  let count = b.readUInt16LE(eocd + 10);
  let dirSize = b.readUInt32LE(eocd + 12);
  let dirOffset = b.readUInt32LE(eocd + 16);
  if (b.readUInt16LE(eocd + 8) !== count) throw new Error("multi-disk zip");
  if (eocd >= 20 && b.readUInt32LE(eocd - 20) === EOCD64_LOCATOR) {
    const at = Number(b.readBigUInt64LE(eocd - 20 + 8));
    if (b.readUInt32LE(at) !== EOCD64) throw new Error("bad zip64 end record");
    count = Number(b.readBigUInt64LE(at + 32));
    dirSize = Number(b.readBigUInt64LE(at + 40));
    dirOffset = Number(b.readBigUInt64LE(at + 48));
  }
  const infos: ZipInfo[] = [];
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== CENTRAL) throw new Error(`bad central directory entry ${n}`);
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    let compressed = b.readUInt32LE(p + 20);
    let size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    let local = b.readUInt32LE(p + 42);
    const filename = b.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    // ZIP64 extra field: the 64-bit values, in order, for each 32-bit field that is 0xffffffff.
    const extra = b.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const next = () => Number(extra.readBigUInt64LE((q += 8) - 8));
        if (size === 0xffffffff) size = next();
        if (compressed === 0xffffffff) compressed = next();
        if (local === 0xffffffff) local = next();
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error(`${filename}: encrypted`);
    if (b.readUInt32LE(local) !== LOCAL) throw new Error(`${filename}: bad local header`);
    const localNameLen = b.readUInt16LE(local + 26);
    const localName = b.subarray(local + 30, local + 30 + localNameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    if (localName !== filename) throw new Error(`${filename}: local header names ${localName}`);
    if (b.readUInt16LE(local + 8) !== method) throw new Error(`${filename}: local header method differs`);
    const start = local + 30 + localNameLen + b.readUInt16LE(local + 28);
    if (start + compressed > dirOffset) throw new Error(`${filename}: data runs into the central directory`);
    const raw = b.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${filename}: compression method ${method}`);
    if (data.length !== size) throw new Error(`${filename}: ${data.length} bytes, the directory says ${size}`);
    if (zlib.crc32(data) >>> 0 !== crc) throw new Error(`${filename}: bad CRC-32`);
    infos.push({ filename, file_size: size, data });
  }
  if (p !== dirOffset + dirSize) throw new Error("central directory size doesn't match the end record");
  return {
    infolist: () => infos,
    namelist: () => infos.map((i) => i.filename),
    read(name) {
      const hit = infos.find((i) => i.filename === name);
      if (!hit) throw new Error(`no ${name} in the zip`);
      return hit.data;
    },
  };
}
