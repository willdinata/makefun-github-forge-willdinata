import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildCommit, buildTree, hashObject, parseCommit, parseTree } from './gitobj.ts';
import type { TreeEntry } from './gitobj.ts';
import { MergeError, mergePullRequest } from './merge.ts';
import {
  createRepo,
  deleteRepo,
  getRepo,
  listRepos,
  nowIso,
  objects,
  renameRepo,
  tickSeconds,
  VIEWER,
} from './store.ts';
import type { IssueRecord, PullRecord, Repository } from './store.ts';

type Json = Record<string, unknown>;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let requestSequence = 0;
const cachedIssueBodies = new WeakMap<IssueRecord, { updatedAt: string; body: string }>();
const notFound = (): never => { throw new HttpError(404, 'Not Found'); };

function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  requestSequence += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': `FORGE-REST-${requestSequence.toString().padStart(8, '0')}`,
    ...headers,
  });
  res.end(body);
}

function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  sendText(res, status, status === 204 ? '' : `${JSON.stringify(value)}\n`, headers);
}

function cachedIssueBody(issue: IssueRecord, repo: Repository): string {
  const cached = cachedIssueBodies.get(issue);
  if (cached?.updatedAt === issue.updatedAt) return cached.body;
  const body = `${JSON.stringify(issueResponse(issue, repo))}\n`;
  cachedIssueBodies.set(issue, { updatedAt: issue.updatedAt, body });
  return body;
}

function errorResponse(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) send(res, error.status, { message: error.message });
  else if (error instanceof MergeError) send(res, error.status, { message: error.message });
  else send(res, 400, { message: error instanceof Error ? error.message : 'Malformed request' });
}

function bodyObject(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return value as Json;
}

function string(value: unknown, label: string, required = true): string {
  if (typeof value === 'string' && (!required || value.length > 0)) return value;
  throw new HttpError(422, `${label} must be ${required ? 'a non-empty ' : 'a '}string`);
}

function repoFor(owner: string, name: string): Repository {
  if (owner !== VIEWER.login) notFound();
  return getRepo(owner, name) ?? notFound();
}

function repoJson(repo: Repository): Json {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: VIEWER.login },
  };
}

function storeObject(type: 'blob' | 'tree' | 'commit', data: Buffer): string {
  const oid = hashObject(type, data);
  objects.set(oid, { type, data });
  return oid;
}

function blobData(oid: string): Buffer | undefined {
  const object = objects.get(oid);
  return object?.type === 'blob' ? object.data : undefined;
}

function commitData(oid: string) {
  const object = objects.get(oid);
  if (!object || object.type !== 'commit') throw new HttpError(422, 'Invalid commit SHA');
  return parseCommit(object.data);
}

function commitTree(oid: string): string {
  return commitData(oid).tree;
}

function resolveCommit(repo: Repository, value: string | null | undefined): string | undefined {
  if (!value) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const ref = value.startsWith('refs/') ? value : `refs/heads/${value}`;
  const tip = repo.refs.get(ref);
  if (tip) return tip;
  const object = objects.get(value);
  return object?.type === 'commit' ? value : undefined;
}

function treeEntries(treeOid: string): TreeEntry[] {
  const object = objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

function getPathEntry(treeOid: string, path: string): TreeEntry | undefined {
  const parts = path.split('/');
  let current = treeOid;
  let found: TreeEntry | undefined;
  for (const [index, part] of parts.entries()) {
    found = treeEntries(current).find((entry) => entry.name === part);
    if (!found) return undefined;
    if (index < parts.length - 1) {
      if (found.mode !== '40000') return undefined;
      current = found.oid;
    }
  }
  return found;
}

function flattenTree(treeOid: string, prefix = '', result = new Map<string, string>()): Map<string, string> {
  for (const entry of treeEntries(treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, result);
    else result.set(path, entry.oid);
  }
  return result;
}

function buildNestedTree(files: ReadonlyMap<string, string>): string {
  const root = new Map<string, string | Map<string, unknown>>();
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.get(part);
      if (!(child instanceof Map)) {
        child = new Map<string, string | Map<string, unknown>>();
        node.set(part, child);
      }
      node = child as Map<string, string | Map<string, unknown>>;
    }
    node.set(parts.at(-1)!, oid);
  }
  const write = (node: Map<string, string | Map<string, unknown>>): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node) {
      if (typeof value === 'string') entries.push({ mode: '100644', name, oid: value });
      else entries.push({ mode: '40000', name, oid: write(value as Map<string, string | Map<string, unknown>>) });
    }
    return storeObject('tree', buildTree(entries));
  };
  return write(root);
}

function makeCommit(tree: string, parents: string[], message: string): string {
  tickSeconds();
  const epoch = Math.floor(Date.parse(nowIso()) / 1000);
  const identity = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
  return storeObject('commit', buildCommit({ tree, parents, author: identity, committer: identity, message }));
}

function updateRef(repo: Repository, branch: string, sha: string): void {
  repo.refs.set(`refs/heads/${branch}`, sha);
  tickSeconds();
}

function commitForFileChange(repo: Repository, branch: string, files: Map<string, string>, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const tree = buildNestedTree(files);
  const sha = makeCommit(tree, parent ? [parent] : [], message);
  updateRef(repo, branch, sha);
  return sha;
}

function validPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new HttpError(404, 'Not Found');
  }
  return normalized;
}

function decodeContent(encoded: unknown): Buffer {
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new HttpError(422, 'content must be valid base64');
  }
  return Buffer.from(encoded, 'base64');
}

function issueLabels(repo: Repository, number: number): Array<{ name: string }> {
  return repo.issueLabelNames.get(number)?.map((name) => ({ name })) ?? [];
}

function issueResponse(issue: IssueRecord, repo: Repository): Json {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issueLabels(repo, issue.number),
    user: { login: VIEWER.login },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(repo: Repository, pull: PullRecord): Json {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    user: { login: VIEWER.login },
  };
}

function paginate<T>(items: T[], url: URL, req: IncomingMessage, res: ServerResponse): T[] {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  if (start + perPage < items.length) {
    const proto = (req.headers['x-forwarded-proto']?.toString().split(',')[0] ?? 'http').trim();
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname + url.search, `${proto}://${host}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    res.setHeader('link', `<${next.toString()}>; rel="next"`);
  }
  return items.slice(start, start + perPage);
}

function refSha(repo: Repository, ref: string): string | undefined {
  return resolveCommit(repo, ref);
}

function commitsFrom(repo: Repository, start: string | undefined): Json[] {
  const commits: Json[] = [];
  let current = start;
  while (current) {
    const data = commitData(current);
    const parseIdentity = (identity: string): Json => {
      const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(identity);
      return {
        name: match?.[1] ?? VIEWER.name,
        email: match?.[2] ?? VIEWER.email,
        date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString(),
      };
    };
    commits.push({
      sha: current,
      commit: {
        message: data.message.toString('utf8'),
        author: parseIdentity(data.author),
        committer: parseIdentity(data.committer),
      },
      parents: data.parents.map((sha) => ({ sha })),
    });
    current = data.parents[0];
  }
  return commits;
}

function listDirectory(treeOid: string, path: string): Json[] | undefined {
  let current = treeOid;
  if (path !== '') {
    const entry = getPathEntry(treeOid, path);
    if (!entry || entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return treeEntries(current).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
  }));
}

function countLineChanges(before: Buffer | undefined, after: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = before ? before.toString('utf8').split('\n') : [];
  const newLines = after ? after.toString('utf8').split('\n') : [];
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const count = counts.get(line) ?? 0;
    if (count === 0) additions += 1;
    else counts.set(line, count - 1);
  }
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let deletions = 0;
  for (const line of oldLines) {
    const count = newCounts.get(line) ?? 0;
    if (count === 0) deletions += 1;
    else newCounts.set(line, count - 1);
  }
  return { additions, deletions };
}

export function diffFiles(repo: Repository, pull: PullRecord): Json[] {
  const baseSha = pull.baseSha;
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  if (!headSha) return [];
  const before = flattenTree(commitTree(baseSha));
  const after = flattenTree(commitTree(headSha));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out: Json[] = [];
  for (const path of paths) {
    const oldOid = before.get(path);
    const newOid = after.get(path);
    if (oldOid === newOid) continue;
    const oldData = oldOid ? blobData(oldOid) : undefined;
    const newData = newOid ? blobData(newOid) : undefined;
    const { additions, deletions } = countLineChanges(oldData, newData);
    out.push({
      filename: path,
      status: oldOid === undefined ? 'added' : newOid === undefined ? 'deleted' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

function parseSegments(url: URL): string[] {
  try {
    return url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, 'Malformed URL path');
  }
}

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  jsonBody: unknown,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v3/')) return false;
  try {
    const segments = parseSegments(url);
    const route = segments.slice(2);
    const method = req.method ?? 'GET';
    if (route.length === 0 && method === 'GET') {
      send(res, 200, {}, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    if (route.length === 1 && route[0] === 'meta' && method === 'GET') {
      send(res, 200, { installed_version: '1.0.0' });
      return true;
    }
    if (route.length === 1 && route[0] === 'user' && method === 'GET') {
      send(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
      return true;
    }
    if (route[0] === 'user' && route[1] === 'repos') {
      if (method === 'POST' && route.length === 2) {
        const body = bodyObject(jsonBody);
        const name = string(body.name, 'name');
        try {
          const repo = createRepo(VIEWER.login, name, {
            description: typeof body.description === 'string' ? body.description : '',
            private: typeof body.private === 'boolean' ? body.private : false,
          });
          send(res, 201, repoJson(repo));
        } catch (error) {
          throw new HttpError(422, error instanceof Error ? error.message : 'Repository could not be created');
        }
        return true;
      }
      if (method === 'GET' && route.length === 2) {
        const repos = listRepos(VIEWER.login).map(repoJson);
        const page = paginate(repos, url, req, res);
        send(res, 200, page);
        return true;
      }
    }
    if (route[0] !== 'repos' || route.length < 3) return false;
    const owner = route[1]!;
    const name = route[2]!;
    const repo = repoFor(owner, name);
    const tail = route.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') { send(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        const body = bodyObject(jsonBody);
        if (body.name !== undefined) {
          const newName = string(body.name, 'name');
          const renamed = renameRepo(owner, name, newName);
          if (!renamed) throw new HttpError(422, 'Repository name already exists');
          repo.name = newName;
        }
        if (body.description !== undefined) repo.description = string(body.description, 'description', false);
        if (body.private !== undefined) {
          if (typeof body.private !== 'boolean') throw new HttpError(422, 'private must be a boolean');
          repo.private = body.private;
        }
        tickSeconds();
        send(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        deleteRepo(owner, name);
        send(res, 204, null);
        return true;
      }
    }

    if (tail[0] === 'contents') {
      const path = validPath(tail.slice(1).join('/'));
      if (method === 'GET') {
        const commit = resolveCommit(repo, url.searchParams.get('ref'));
        if (!commit) notFound();
        const tree = commitTree(commit);
        const entry = getPathEntry(tree, path);
        if (entry?.mode === '40000') {
          const listing = listDirectory(tree, path);
          if (!listing) notFound();
          send(res, 200, listing);
        } else if (entry) {
          const data = blobData(entry.oid);
          if (!data) notFound();
          send(res, 200, {
            type: 'file', name: path.split('/').at(-1), path, sha: entry.oid,
            size: data.length, encoding: 'base64', content: data.toString('base64'),
          });
        } else notFound();
        return true;
      }
      if (method === 'PUT') {
        const body = bodyObject(jsonBody);
        const message = string(body.message, 'message');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        const parent = repo.refs.get(ref);
        if (!parent && repo.refs.size > 0) throw new HttpError(422, 'Branch not found');
        const tree = parent ? commitTree(parent) : '';
        const files = tree ? flattenTree(tree) : new Map<string, string>();
        const previous = files.get(path);
        if (previous && body.sha !== previous) throw new HttpError(409, 'sha does not match the current file');
        if (!previous && body.sha !== undefined) throw new HttpError(409, 'sha does not match the current file');
        const data = decodeContent(body.content);
        const blob = storeObject('blob', data);
        files.set(path, blob);
        const sha = commitForFileChange(repo, branch, files, message);
        send(res, previous ? 200 : 201, {
          content: { name: path.split('/').at(-1), path, sha: blob, size: data.length, encoding: 'base64' },
          commit: { sha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = bodyObject(jsonBody);
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        const parent = repo.refs.get(ref);
        if (!parent) throw new HttpError(422, 'Branch not found');
        const files = flattenTree(commitTree(parent));
        const current = files.get(path);
        if (!current) notFound();
        if (body.sha !== current) throw new HttpError(409, 'sha does not match the current file');
        files.delete(path);
        const sha = commitForFileChange(repo, branch, files, string(body.message, 'message'));
        send(res, 200, { content: null, commit: { sha } });
        return true;
      }
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const body = bodyObject(jsonBody);
        const ref = string(body.ref, 'ref');
        const sha = string(body.sha, 'sha');
        const object = objects.get(sha);
        if (!object || object.type !== 'commit') throw new HttpError(422, 'Invalid commit SHA');
        if (!ref.startsWith('refs/heads/') || repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists or is invalid');
        repo.refs.set(ref, sha);
        tickSeconds();
        send(res, 201, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
        const ref = `refs/heads/${tail[3]}`;
        const sha = repo.refs.get(ref);
        if (!sha) notFound();
        send(res, 200, { ref, object: { sha } });
        return true;
      }
    }
    if (tail[0] === 'branches' && method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
      send(res, 200, branches);
      return true;
    }
    if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) {
      const sha = refSha(repo, url.searchParams.get('sha'));
      if (url.searchParams.has('sha') && !sha) notFound();
      send(res, 200, commitsFrom(repo, sha));
      return true;
    }
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        send(res, 200, [...repo.labels.values()].map(({ name: label, color }) => ({ name: label, color })));
        return true;
      }
      if (method === 'POST' && tail.length === 1) {
        const body = bodyObject(jsonBody);
        const label = string(body.name, 'name');
        const color = string(body.color, 'color');
        if (repo.labels.has(label)) throw new HttpError(422, 'Label already exists');
        repo.labels.set(label, { name: label, color, description: typeof body.description === 'string' ? body.description : '' });
        tickSeconds();
        send(res, 201, { name: label, color });
        return true;
      }
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'POST') {
        const body = bodyObject(jsonBody);
        const title = string(body.title, 'title', false);
        const names = body.labels === undefined ? [] : body.labels;
        if (!Array.isArray(names) || names.some((label) => typeof label !== 'string')) throw new HttpError(422, 'labels must be an array of names');
        for (const label of names as string[]) if (!repo.labels.has(label)) throw new HttpError(422, `Label "${label}" does not exist`);
        const number = repo.nextIssueNumber++;
        tickSeconds();
        const now = nowIso();
        const issue: IssueRecord = { id: number, number, title, body: typeof body.body === 'string' ? body.body : '', state: 'open', createdAt: now, updatedAt: now };
        repo.issues.set(number, issue);
        repo.issueLabelNames.set(number, [...names] as string[]);
        send(res, 201, issueResponse(issue, repo));
        return true;
      }
      if (tail.length === 1 && method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
        if (url.searchParams.get('sort') === 'created' && url.searchParams.get('direction') === 'desc') issues.reverse();
        send(res, 200, paginate(issues.map((issue) => issueResponse(issue, repo)), url, req, res));
        return true;
      }
      const number = Number(tail[1]);
      if (tail.length === 2 && Number.isInteger(number) && number > 0) {
        const issue = repo.issues.get(number);
        if (method === 'GET') {
          if (issue) sendText(res, 200, cachedIssueBody(issue, repo));
          else {
            const pull = repo.pulls.get(number);
            if (pull) send(res, 200, pullJson(repo, pull));
            else notFound();
          }
          return true;
        }
        if (method === 'PATCH') {
          if (!issue) notFound();
          const body = bodyObject(jsonBody);
          if (body.state !== undefined) {
            if (body.state !== 'open' && body.state !== 'closed') throw new HttpError(422, 'state must be open or closed');
            issue.state = body.state;
          }
          if (body.title !== undefined) issue.title = string(body.title, 'title', false);
          if (body.body !== undefined) issue.body = string(body.body, 'body', false);
          tickSeconds();
          issue.updatedAt = nowIso();
          send(res, 200, issueResponse(issue, repo));
          return true;
        }
      }
      if (tail[2] === 'comments' && tail.length === 3 && Number.isInteger(number) && number > 0) {
        if (!repo.issues.has(number) && !repo.pulls.has(number)) notFound();
        repo.comments ??= new Map();
        if (method === 'GET') {
          send(res, 200, (repo.comments.get(number) ?? []).map((comment) => ({
            id: comment.id, body: comment.body, user: { login: VIEWER.login }, created_at: comment.createdAt,
          })));
          return true;
        }
        if (method === 'POST') {
          const body = bodyObject(jsonBody);
          const text = string(body.body, 'body', false);
          const list = repo.comments.get(number) ?? [];
          const nextId = repo.nextCommentId++;
          tickSeconds();
          const comment = { id: nextId, body: text, createdAt: nowIso() };
          list.push(comment);
          repo.comments.set(number, list);
          send(res, 201, { id: nextId, body: text, user: { login: VIEWER.login }, created_at: comment.createdAt });
          return true;
        }
      }
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'POST') {
        const body = bodyObject(jsonBody);
        const head = string(body.head, 'head');
        const base = string(body.base, 'base');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) throw new HttpError(422, 'Head or base branch not found');
        if ([...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.head === head && pull.base === base)) {
          throw new HttpError(422, 'A pull request already exists for these branches');
        }
        const number = repo.nextIssueNumber++;
        tickSeconds();
        const now = nowIso();
        const pull: PullRecord = {
          id: number, number, title: string(body.title, 'title', false), body: typeof body.body === 'string' ? body.body : '',
          state: 'open', createdAt: now, updatedAt: now, head, base, baseSha,
          merged: false, mergedAt: null, mergeCommitSha: null,
        };
        repo.pulls.set(number, pull);
        send(res, 201, pullJson(repo, pull));
        return true;
      }
      if (tail.length === 1 && method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const pulls = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state).map((pull) => pullJson(repo, pull));
        send(res, 200, paginate(pulls, url, req, res));
        return true;
      }
      const number = Number(tail[1]);
      const pull = repo.pulls.get(number);
      if (tail.length === 2 && method === 'GET') {
        if (!pull) notFound();
        send(res, 200, pullJson(repo, pull));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) notFound();
        send(res, 200, diffFiles(repo, pull));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) notFound();
        const body = bodyObject(jsonBody);
        const methodValue = body.merge_method ?? 'merge';
        const title = typeof body.commit_title === 'string' ? body.commit_title : `Merge pull request #${number}`;
        const result = mergePullRequest(repo, pull, String(methodValue), typeof body.commit_message === 'string' ? body.commit_message : title);
        send(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
    }
    return false;
  } catch (error) {
    errorResponse(res, error);
    return true;
  }
}
