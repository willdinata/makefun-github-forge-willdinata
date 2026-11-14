export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface PullRecord extends IssueRecord {
  head: string;
  base: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface CommentRecord {
  id: number;
  body: string;
  createdAt: string;
}

export interface Repository {
  databaseId: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: 'main';
  refs: Map<string, string>;
  nextIssueNumber: number;
  nextCommentId: number;
  issues: Map<number, IssueRecord>;
  issueLabelNames: Map<number, string[]>;
  pulls: Map<number, PullRecord>;
  comments: Map<number, CommentRecord[]>;
  labels: Map<string, { name: string; color: string; description: string }>;
  createdSeq: number;
}

export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const objects = new Map<string, GitObject>();
const repositories = new Map<string, Repository>();
let nextRepositoryId = 1;
let nextCreatedSeq = 1;
let epochSeconds = 1_700_000_000;

export function tickSeconds(): number {
  epochSeconds += 1;
  return epochSeconds;
}

export function nowIso(): string {
  return new Date(epochSeconds * 1000).toISOString();
}

export function getRepo(owner: string, name: string): Repository | undefined {
  return repositories.get(`${owner}/${name}`);
}

export function createRepo(
  owner: string,
  name: string,
  fields: { description?: string; private?: boolean } = {},
): Repository {
  if (owner !== VIEWER.login) throw new Error(`repositories can only be created under ${VIEWER.login}`);
  const key = `${owner}/${name}`;
  if (repositories.has(key)) throw new Error(`repository ${key} already exists`);
  tickSeconds();
  const repo: Repository = {
    databaseId: nextRepositoryId++,
    name,
    description: fields.description ?? '',
    private: fields.private ?? false,
    defaultBranch: 'main',
    refs: new Map(),
    nextIssueNumber: 1,
    nextCommentId: 1,
    issues: new Map(),
    issueLabelNames: new Map(),
    pulls: new Map(),
    comments: new Map(),
    labels: new Map(),
    createdSeq: nextCreatedSeq++,
  };
  repositories.set(key, repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  const deleted = repositories.delete(`${owner}/${name}`);
  if (deleted) tickSeconds();
  return deleted;
}

export function renameRepo(owner: string, oldName: string, newName: string): Repository | undefined {
  const repo = repositories.get(`${owner}/${oldName}`);
  if (!repo || repositories.has(`${owner}/${newName}`)) return undefined;
  repositories.delete(`${owner}/${oldName}`);
  repo.name = newName;
  repositories.set(`${owner}/${newName}`, repo);
  tickSeconds();
  return repo;
}

export function listRepos(owner: string): Repository[] {
  return [...repositories.entries()]
    .filter(([key]) => key.startsWith(`${owner}/`))
    .map(([, repo]) => repo)
    .sort((a, b) => a.createdSeq - b.createdSeq);
}
