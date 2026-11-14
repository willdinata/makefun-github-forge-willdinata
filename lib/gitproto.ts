import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildPack, parseCommit, parseTag, parseTree, pktLine, pktLines, readPack, sideband } from './gitobj.ts';
import type { Packet } from './gitobj.ts';
import { getRepo, objects, tickSeconds } from './store.ts';
import type { GitObject } from './store.ts';

const ZERO = '0'.repeat(40);
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
let gitRequestSequence = 0;

function send(res: ServerResponse, contentType: string, body: Buffer, status = 200): void {
  gitRequestSequence += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `FORGE-GIT-${gitRequestSequence.toString().padStart(8, '0')}`,
  });
  res.end(body);
}

async function requestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > 64 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(data);
  }
  return Buffer.concat(chunks, length);
}

function parsePackets(input: Buffer, allowRaw = false): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (offset + 4 > input.length) {
      if (allowRaw) return { packets, rest: input.subarray(offset) };
      throw new Error('truncated pkt-line header');
    }
    const header = input.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      if (allowRaw) return { packets, rest: input.subarray(offset) };
      throw new Error('malformed pkt-line header');
    }
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      packets.push({ kind: length === 0 ? 'flush' : length === 1 ? 'delim' : 'response-end' });
      offset += 4;
      if (allowRaw && length === 0) return { packets, rest: input.subarray(offset) };
      continue;
    }
    if (length < 4 || offset + length > input.length) throw new Error('invalid or truncated pkt-line');
    packets.push({ kind: 'data', payload: input.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

function textPackets(packets: readonly Packet[]): string[] {
  return packets.flatMap((packet) => packet.kind === 'data' ? [packet.payload.toString('utf8').replace(/\n$/, '')] : []);
}

function tagPeel(oid: string): string | undefined {
  let current = oid;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const object = objects.get(current);
    if (!object || object.type !== 'tag') return current === oid ? undefined : current;
    current = parseTag(object.data).object;
  }
  return undefined;
}

function repoRefs(repo: NonNullable<ReturnType<typeof getRepo>>): Array<{ oid: string; name: string }> {
  return [...repo.refs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, oid]) => ({ oid, name }));
}

function uploadAdvertisement(repo: NonNullable<ReturnType<typeof getRepo>>, v2: boolean): Buffer {
  if (v2) return pktLines(['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n', 'flush']);
  const refs = repoRefs(repo);
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const capabilities = `side-band-64k ofs-delta shallow${head ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : ''}`;
  const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO} capabilities^{}\0${capabilities}\n`);
  } else {
    let first = true;
    if (head) {
      lines.push(`${head} HEAD\0${capabilities}\n`);
      first = false;
    }
    for (const ref of refs) {
      lines.push(first ? `${ref.oid} ${ref.name}\0${capabilities}\n` : `${ref.oid} ${ref.name}\n`);
      first = false;
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = tagPeel(ref.oid);
        if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

function receiveAdvertisement(repo: NonNullable<ReturnType<typeof getRepo>>): Buffer {
  const refs = repoRefs(repo);
  const capabilities = 'report-status side-band-64k delete-refs ofs-delta';
  const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO} capabilities^{}\0${capabilities}\n`);
  } else {
    refs.forEach((ref, index) => {
      lines.push(index === 0
        ? `${ref.oid} ${ref.name}\0${capabilities}\n`
        : `${ref.oid} ${ref.name}\n`);
    });
  }
  lines.push('flush');
  return pktLines(lines);
}

function resolveClosure(roots: readonly string[], shallow: ReadonlySet<string>, depth?: number): { ids: Set<string>; boundaries: Set<string> } {
  const ids = new Set<string>();
  const boundaries = new Set<string>();
  const stack: Array<{ oid: string; generation: number }> = roots.map((oid) => ({ oid, generation: 1 }));
  const commitGeneration = new Map<string, number>();
  while (stack.length) {
    const { oid, generation } = stack.pop()!;
    const object = objects.get(oid);
    if (!object) continue;
    if (object.type === 'tree') {
      if (ids.has(oid)) continue;
      ids.add(oid);
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push({ oid: entry.oid, generation });
    } else if (object.type === 'tag') {
      if (ids.has(oid)) continue;
      ids.add(oid);
      stack.push({ oid: parseTag(object.data).object, generation });
    } else if (object.type === 'commit') {
      const previousGeneration = commitGeneration.get(oid);
      if (previousGeneration !== undefined && previousGeneration <= generation) continue;
      commitGeneration.set(oid, generation);
      ids.add(oid);
      const commit = parseCommit(object.data);
      stack.push({ oid: commit.tree, generation });
      if (depth !== undefined && generation >= depth) {
        if (commit.parents.length) boundaries.add(oid);
      } else if (!shallow.has(oid)) {
        boundaries.delete(oid);
        for (const parent of commit.parents) stack.push({ oid: parent, generation: generation + 1 });
      }
    } else {
      ids.add(oid);
    }
  }
  return { ids, boundaries };
}

function selectPack(
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth?: number,
): { pack: Buffer; boundaries: Set<string>; unshallow: Set<string> } {
  const haveClosure = resolveClosure(haves, new Set(clientShallow)).ids;
  const wanted = resolveClosure(wants, new Set(), depth);
  const ids = [...wanted.ids].filter((oid) => !haveClosure.has(oid));
  const packObjects: GitObject[] = [];
  for (const oid of ids) {
    const object = objects.get(oid);
    if (object) packObjects.push(object);
  }
  const unshallow = new Set(clientShallow.filter((oid) => !wanted.boundaries.has(oid)));
  return { pack: buildPack(packObjects), boundaries: wanted.boundaries, unshallow };
}

function parseUploadRequest(body: Buffer, v2: boolean): { command: string; lines: string[] } {
  const parsed = parsePackets(body);
  const lines = textPackets(parsed.packets).map((line) => line.split('\0', 1)[0]);
  if (v2) {
    const command = lines.find((line) => line.startsWith('command='))?.slice(8) ?? '';
    return { command, lines };
  }
  return { command: 'v0-fetch', lines };
}

function handleLsRefs(repo: NonNullable<ReturnType<typeof getRepo>>, lines: string[]): Buffer {
  const args = lines.slice(lines.findIndex((line) => line === 'delim') + 1);
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11));
  const symrefs = args.includes('symrefs');
  const peel = args.includes('peel');
  const unborn = args.includes('unborn');
  const refs = repoRefs(repo);
  const headName = `refs/heads/${repo.defaultBranch}`;
  const head = repo.refs.get(headName);
  const selected: Array<{ oid: string; name: string; unborn?: boolean }> = [];
  if (prefixes.length === 0 && head) selected.push({ oid: head, name: 'HEAD' });
  else if (prefixes.length === 0 && !head && unborn) selected.push({ oid: ZERO, name: 'HEAD', unborn: true });
  for (const ref of refs) {
    if (prefixes.length && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    selected.push(ref);
  }
  const response: string[] = [];
  for (const ref of selected) {
    let line = ref.unborn ? `unborn ${ref.name}` : `${ref.oid} ${ref.name}`;
    if (symrefs && ref.name === 'HEAD') line += ` symref-target:${headName}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = tagPeel(ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    response.push(`${line}\n`);
  }
  response.push('flush');
  return pktLines(response);
}

function handleFetch(lines: string[], v2: boolean): Buffer {
  const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).split(' ')[0]).filter((oid) => objects.has(oid));
  const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).split(' ')[0]);
  const shallow = lines.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8));
  const depthLine = lines.find((line) => line.startsWith('deepen '));
  const depth = depthLine ? Number.parseInt(depthLine.slice(7), 10) : undefined;
  const deepening = lines.some((line) => line.startsWith('deepen ')) || lines.some((line) => line.startsWith('deepen-since ')) || lines.some((line) => line.startsWith('deepen-not '));
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) throw new Error('invalid deepen depth');
  const selected = selectPack(wants, haves, shallow, depth);
  const chunks: Buffer[] = [];
  if (v2) {
    if (deepening || shallow.length) {
      chunks.push(pktLine('shallow-info\n'));
      for (const oid of selected.boundaries) chunks.push(pktLine(`shallow ${oid}\n`));
      for (const oid of selected.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
      chunks.push(Buffer.from('0001'));
    }
    chunks.push(pktLine('packfile\n'));
    for (let offset = 0; offset < selected.pack.length; offset += 65515) {
      chunks.push(sideband(1, selected.pack.subarray(offset, Math.min(offset + 65515, selected.pack.length))));
    }
  } else {
    for (const oid of selected.boundaries) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selected.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(pktLine('NAK\n'));
    for (let offset = 0; offset < selected.pack.length; offset += 65515) {
      chunks.push(sideband(1, selected.pack.subarray(offset, Math.min(offset + 65515, selected.pack.length))));
    }
  }
  chunks.push(Buffer.from('0000'));
  return Buffer.concat(chunks);
}

function isAncestor(ancestor: string, tip: string): boolean {
  const pending = [tip];
  const seen = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object?.type === 'commit') pending.push(...parseCommit(object.data).parents);
  }
  return false;
}

function receivePack(repo: NonNullable<ReturnType<typeof getRepo>>, body: Buffer): Buffer {
  const commandSection = parsePackets(body, true);
  if (!commandSection.packets.some((packet) => packet.kind === 'flush')) throw new Error('receive-pack command list has no flush');
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const line of textPackets(commandSection.packets)) {
    const command = line.split('\0', 1)[0].trim();
    if (!command) continue;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(command);
    if (!match) throw new Error('malformed receive-pack command');
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  let unpack = 'ok';
  if (commandSection.rest.length) {
    try {
      for (const [oid, object] of readPack(commandSection.rest, (oid) => objects.get(oid))) {
        if (!objects.has(oid)) {
          objects.set(oid, object);
          tickSeconds();
        }
      }
    } catch (error) {
      unpack = error instanceof Error ? error.message.replace(/[\r\n]/g, ' ') : String(error);
    }
  }
  const reports = [pktLine(`unpack ${unpack}\n`)];
  for (const command of commands) {
    if (unpack !== 'ok') {
      reports.push(pktLine(`ng ${command.ref} ${unpack}\n`));
      continue;
    }
    if (command.newOid === ZERO) {
      const ref = repo.refs.get(command.ref);
      if (ref) {
        repo.refs.delete(command.ref);
        tickSeconds();
      }
      reports.push(pktLine(`ok ${command.ref}\n`));
      continue;
    }
    const old = repo.refs.get(command.ref);
    if (command.ref.startsWith('refs/heads/') && (old ?? ZERO) !== command.oldOid) {
      reports.push(pktLine(`ng ${command.ref} stale-info\n`));
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && old && !isAncestor(command.oldOid, command.newOid)) {
      reports.push(pktLine(`ng ${command.ref} non-fast-forward\n`));
      continue;
    }
    if (!objects.has(command.newOid)) {
      reports.push(pktLine(`ng ${command.ref} missing-object\n`));
      continue;
    }
    if (old !== command.newOid) {
      repo.refs.set(command.ref, command.newOid);
      tickSeconds();
    }
    reports.push(pktLine(`ok ${command.ref}\n`));
  }
  return Buffer.concat(reports.map((packet) => sideband(1, packet)).concat(Buffer.from('0000')));
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const action = match[3] ?? '';
  const repo = getRepo(owner, repoName);
  if (!repo) {
    send(res, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n'), 404);
    return true;
  }
  if (req.method === 'GET' && action === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const v2 = req.headers['git-protocol'] === 'version=2';
      send(res, UPLOAD_AD, uploadAdvertisement(repo, v2));
    } else if (service === 'git-receive-pack') {
      send(res, RECEIVE_AD, receiveAdvertisement(repo));
    } else {
      send(res, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n'), 404);
    }
    return true;
  }
  if (req.method === 'POST' && action === 'git-upload-pack') {
    const v2 = req.headers['git-protocol'] === 'version=2';
    const body = await requestBody(req);
    const request = parseUploadRequest(body, v2);
    if (v2 && request.command === 'ls-refs') send(res, UPLOAD_RESULT, handleLsRefs(repo, request.lines));
    else if ((v2 && request.command === 'fetch') || !v2) send(res, UPLOAD_RESULT, handleFetch(request.lines, v2));
    else throw new Error(`unsupported upload-pack command ${request.command}`);
    return true;
  }
  if (req.method === 'POST' && action === 'git-receive-pack') {
    const body = await requestBody(req);
    send(res, RECEIVE_RESULT, receivePack(repo, body));
    return true;
  }
  send(res, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n'), 404);
  return true;
}
