import { buildCommit, buildTree, hashObject, parseCommit, parseTree } from './gitobj.ts';
import type { TreeEntry } from './gitobj.ts';
import { nowIso, objects, tickSeconds, VIEWER } from './store.ts';
import type { PullRecord, Repository } from './store.ts';

export class MergeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function commitTree(sha: string): string {
  const object = objects.get(sha);
  if (!object || object.type !== 'commit') throw new MergeError(405, 'Invalid commit SHA');
  return parseCommit(object.data).tree;
}

function flattenTree(treeSha: string, prefix = '', files = new Map<string, string>()): Map<string, string> {
  const object = objects.get(treeSha);
  if (!object || object.type !== 'tree') return files;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, files);
    else files.set(path, entry.oid);
  }
  return files;
}

function storeTree(entries: TreeEntry[]): string {
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  objects.set(oid, { type: 'tree', data });
  return oid;
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
    return storeTree(entries);
  };
  return write(root);
}

function mergeBase(left: string, right: string): string | undefined {
  const ancestors = new Set<string>();
  const stack = [left];
  while (stack.length) {
    const oid = stack.pop()!;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const object = objects.get(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  const pending = [right];
  const seen = new Set<string>();
  while (pending.length) {
    const oid = pending.shift()!;
    if (ancestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object?.type === 'commit') pending.push(...parseCommit(object.data).parents);
  }
  return undefined;
}

function mergeTrees(baseSha: string, oursSha: string, theirsSha: string): Map<string, string> {
  const base = flattenTree(commitTree(baseSha));
  const ours = flattenTree(commitTree(oursSha));
  const theirs = flattenTree(commitTree(theirsSha));
  const result = new Map<string, string>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let value: string | undefined;
    if (o === b) value = t;
    else if (t === b) value = o;
    else if (o === t) value = o;
    else throw new MergeError(405, 'Merge conflict');
    if (value !== undefined) result.set(path, value);
  }
  return result;
}

function computeMergedFiles(repo: Repository, pull: PullRecord): { baseTip: string; headTip: string; files: Map<string, string> } {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) throw new MergeError(405, 'Head or base branch not found');
  const base = mergeBase(baseTip, headTip);
  if (!base) throw new MergeError(405, 'No common ancestor');
  return { baseTip, headTip, files: mergeTrees(base, baseTip, headTip) };
}

export function pullMergeability(repo: Repository, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  try {
    computeMergedFiles(repo, pull);
    return 'MERGEABLE';
  } catch (error) {
    if (error instanceof MergeError && error.message === 'Merge conflict') return 'CONFLICTING';
    return 'UNKNOWN';
  }
}

export function mergePullRequest(
  repo: Repository,
  pull: PullRecord,
  method: string = 'merge',
  commitTitle = `Merge pull request #${pull.number}`,
): { sha: string; merged: true } {
  if (pull.merged) throw new MergeError(405, 'Pull request has already been merged');
  const normalizedMethod = method.toLowerCase();
  if (!['merge', 'squash', 'rebase'].includes(normalizedMethod)) throw new MergeError(422, 'Invalid merge method');
  const { baseTip, headTip, files } = computeMergedFiles(repo, pull);
  const tree = buildNestedTree(files);
  tickSeconds();
  const epoch = Math.floor(Date.parse(nowIso()) / 1000);
  const identity = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
  const data = buildCommit({
    tree,
    parents: normalizedMethod === 'merge' ? [baseTip, headTip] : [baseTip],
    author: identity,
    committer: identity,
    message: commitTitle,
  });
  const sha = hashObject('commit', data);
  objects.set(sha, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  tickSeconds();
  tickSeconds();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { sha, merged: true };
}
