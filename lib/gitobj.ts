import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType } from './store.ts';

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: Buffer;
  headers: string[];
}

export interface TagData {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType | undefined> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const oidPattern = /^[0-9a-f]{40}$/;

class MissingDeltaBaseError extends Error {}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.from(data);
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

function compareEntries(a: TreeEntry, b: TreeEntry): number {
  return Buffer.compare(Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name), Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name));
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const input = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < input.length) {
    const space = input.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : input.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > input.length) throw new Error('malformed tree object');
    const oid = input.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({
      mode: input.subarray(offset, space).toString('ascii'),
      name: input.subarray(space + 1, nul).toString('utf8'),
      oid,
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareEntries);
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    if (!oidPattern.test(entry.oid)) throw new Error(`invalid tree object id: ${entry.oid}`);
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export function parseCommit(data: Uint8Array): CommitData {
  const input = Buffer.from(data);
  const separator = input.indexOf('\n\n');
  if (separator < 0) throw new Error('malformed commit object');
  const lines = input.subarray(0, separator).toString('utf8').split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const headers: string[] = [];
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else headers.push(line);
  }
  if (!oidPattern.test(tree) || parents.some((id) => !oidPattern.test(id))) throw new Error('malformed commit object ids');
  return { tree, parents, author, committer, message: input.subarray(separator + 2), headers };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer?: string;
  message: Uint8Array | string;
  headers?: readonly string[];
}): Buffer {
  if (!oidPattern.test(fields.tree)) throw new Error('invalid commit tree id');
  const lines = [`tree ${fields.tree}`, ...(fields.parents ?? []).map((parent) => `parent ${parent}`), ...((fields.headers ?? [])), `author ${fields.author}`, `committer ${fields.committer ?? fields.author}`];
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n\n`), Buffer.isBuffer(fields.message) ? fields.message : Buffer.from(fields.message)]);
}

export function parseTag(data: Uint8Array): TagData {
  const input = Buffer.from(data);
  const separator = input.indexOf('\n\n');
  if (separator < 0) throw new Error('malformed tag object');
  const headers = new Map(input.subarray(0, separator).toString('utf8').split('\n').map((line) => {
    const space = line.indexOf(' ');
    return [line.slice(0, space), line.slice(space + 1)];
  }));
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!oidPattern.test(object) || !Object.hasOwn(TYPE_CODE, type)) throw new Error('malformed tag object headers');
  return { object, type: type as GitObjectType, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message: input.subarray(separator + 2) };
}

export function buildTag(fields: TagData): Buffer {
  if (!oidPattern.test(fields.object)) throw new Error('invalid tag object id');
  return Buffer.concat([Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n`), fields.message]);
}

function writeObjectHeader(type: GitObjectType, size: number): Buffer {
  let first = (TYPE_CODE[type] << 4) | (size & 15);
  size = Math.floor(size / 16);
  const bytes: number[] = [];
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function buildPack(input: Iterable<GitObject>): Buffer {
  const list = [...input];
  const entries = list.map(({ type, data }) => ({
    header: writeObjectHeader(type, data.length),
    compressed: deflateSync(data),
  }));
  const bodyLength = 12 + entries.reduce((length, entry) => length + entry.header.length + entry.compressed.length, 0);
  const pack = Buffer.allocUnsafe(bodyLength + 20);
  pack.write('PACK', 0);
  pack.writeUInt32BE(2, 4);
  pack.writeUInt32BE(list.length, 8);
  let offset = 12;
  for (const entry of entries) {
    offset += entry.header.copy(pack, offset);
    offset += entry.compressed.copy(pack, offset);
  }
  createHash('sha1').update(pack.subarray(0, bodyLength)).digest().copy(pack, bodyLength);
  return pack;
}

function readSize(buf: Buffer, offset: { value: number }): { size: number; first: number } {
  if (offset.value >= buf.length) throw new Error('truncated pack entry header');
  let byte = buf[offset.value++];
  const first = byte;
  let size = byte & 15;
  let shift = 4;
  while (byte & 128) {
    if (offset.value >= buf.length || shift > 63) throw new Error('invalid pack size varint');
    byte = buf[offset.value++];
    size += (byte & 127) * 2 ** shift;
    shift += 7;
  }
  return { size, first };
}

function readDelta(base: Buffer, delta: Buffer): Buffer {
  let cursor = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (cursor >= delta.length || shift > 63) throw new Error('invalid delta varint');
      const byte = delta[cursor++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
  };
  if (varint() !== base.length) throw new Error('delta base size mismatch');
  const targetSize = varint();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (cursor < delta.length) {
    const op = delta[cursor++];
    if (op & 128) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) copyOffset += delta[cursor++] * 2 ** (i * 8);
      for (let i = 0; i < 3; i += 1) if (op & (1 << (i + 4))) copySize += delta[cursor++] * 2 ** (i * 8);
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > out.length) throw new Error('delta copy exceeds bounds');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else {
      if (op === 0 || cursor + op > delta.length || written + op > out.length) throw new Error('invalid delta insertion');
      delta.copy(out, written, cursor, cursor + op);
      cursor += op;
      written += op;
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

export function readPack(pack: Uint8Array, lookup: (oid: string) => GitObject | undefined = () => undefined): Map<string, GitObject> {
  const buf = Buffer.from(pack);
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('invalid pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerAt = buf.length - 20;
  if (!createHash('sha1').update(buf.subarray(0, trailerAt)).digest().equals(buf.subarray(trailerAt))) throw new Error('pack checksum mismatch');
  type Entry = { offset: number; code: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; value?: GitObject; oid?: string };
  const entries: Entry[] = [];
  const offsets = new Map<number, Entry>();
  const cursor = { value: 12 };
  for (let i = 0; i < count; i += 1) {
    const offset = cursor.value;
    const header = readSize(buf, cursor);
    const code = (header.first >> 4) & 7;
    const entry: Entry = { offset, code, size: header.size, data: Buffer.alloc(0) };
    if (code === 6) {
      if (cursor.value >= trailerAt) throw new Error('truncated OFS_DELTA base');
      let byte = buf[cursor.value++];
      let distance = byte & 127;
      while (byte & 128) {
        if (cursor.value >= trailerAt) throw new Error('truncated OFS_DELTA base');
        byte = buf[cursor.value++];
        distance = (distance + 1) * 128 + (byte & 127);
      }
      entry.baseOffset = offset - distance;
    } else if (code === 7) {
      if (cursor.value + 20 > trailerAt) throw new Error('truncated REF_DELTA base');
      entry.baseOid = buf.subarray(cursor.value, cursor.value + 20).toString('hex');
      cursor.value += 20;
    } else if (!CODE_TYPE[code]) throw new Error(`invalid pack object type ${code}`);
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(buf.subarray(cursor.value, trailerAt), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    } catch (error) {
      throw new Error(`invalid compressed pack object: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!inflated.engine.bytesWritten || inflated.buffer.length !== header.size) throw new Error('pack object size mismatch');
    entry.data = inflated.buffer;
    cursor.value += inflated.engine.bytesWritten;
    entries.push(entry);
    offsets.set(offset, entry);
  }
  if (cursor.value !== trailerAt) throw new Error('unexpected bytes before pack trailer');

  const result = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, Entry>();
  const resolve = (entry: Entry): { oid: string; value: GitObject } => {
    if (entry.value && entry.oid) return { oid: entry.oid, value: entry.value };
    if (resolving.has(entry.offset)) throw new Error('delta dependency cycle');
    resolving.add(entry.offset);
    try {
      let type: GitObjectType;
      let data: Buffer;
      if (entry.code === 6 || entry.code === 7) {
        const baseEntry = entry.code === 6 ? offsets.get(entry.baseOffset!) : resolvedByOid.get(entry.baseOid!);
        const base = baseEntry ? resolve(baseEntry).value : entry.code === 7 ? lookup(entry.baseOid!) : undefined;
        if (!base) throw new MissingDeltaBaseError(`missing delta base ${entry.baseOid ?? entry.baseOffset}`);
        type = base.type;
        data = readDelta(base.data, entry.data);
      } else {
        type = CODE_TYPE[entry.code]!;
        data = entry.data;
      }
      const oid = hashObject(type, data);
      const value = { type, data };
      entry.oid = oid;
      entry.value = value;
      resolvedByOid.set(oid, entry);
      return { oid, value };
    } finally {
      resolving.delete(entry.offset);
    }
  };
  for (const entry of entries) {
    if (entry.code !== 6 && entry.code !== 7) {
      const item = resolve(entry);
      result.set(item.oid, item.value);
    }
  }
  let pending = entries.filter((entry) => entry.code === 6 || entry.code === 7);
  let deferredError: MissingDeltaBaseError | undefined;
  while (pending.length) {
    const remaining: Entry[] = [];
    let resolvedOne = false;
    for (const entry of pending) {
      try {
        const item = resolve(entry);
        result.set(item.oid, item.value);
        resolvedOne = true;
      } catch (error) {
        if (!(error instanceof MissingDeltaBaseError)) throw error;
        deferredError = error;
        remaining.push(entry);
      }
    }
    if (!resolvedOne) throw deferredError ?? new Error('unable to resolve pack deltas');
    pending = remaining;
  }
  return result;
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktLine(payload: string | Uint8Array): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  return Buffer.concat(lines.map((line) => line === 'flush' ? Buffer.from('0000') : line === 'delim' ? Buffer.from('0001') : pktLine(line)));
}

export function decodePktLines(data: Uint8Array): { packets: Packet[]; rest: Buffer } {
  const input = Buffer.from(data);
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (offset + 4 > input.length) throw new Error('truncated pkt-line header');
    const text = input.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) throw new Error('invalid pkt-line header');
    const length = Number.parseInt(text, 16);
    if (length === 0 || length === 1 || length === 2) {
      packets.push({ kind: length === 0 ? 'flush' : length === 1 ? 'delim' : 'response-end' });
      offset += 4;
      if (length === 0 && offset < input.length) return { packets, rest: input.subarray(offset) };
      continue;
    }
    if (length < 4 || offset + length > input.length) throw new Error('invalid or truncated pkt-line');
    packets.push({ kind: 'data', payload: input.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

export function pktBodyLines(packets: readonly Packet[]): string[] {
  return packets.flatMap((packet) => packet.kind === 'data' ? [packet.payload.toString('utf8').replace(/\n$/, '')] : []);
}

export function sideband(band: number, payload: Uint8Array): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), Buffer.from(payload)]));
}
