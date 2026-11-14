import type { ServerResponse } from 'node:http';
import { diffFiles } from './rest.ts';
import { mergePullRequest, pullMergeability } from './merge.ts';
import { createRepo, getRepo, listRepos, nowIso, tickSeconds, VIEWER } from './store.ts';
import type { IssueRecord, PullRecord, Repository } from './store.ts';

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, ValueNode>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  type: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

class GraphqlError extends Error {}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s|,/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread', value: '...' });
      index += 3;
      continue;
    }
    if (char === '"') {
      const start = index++;
      let escaped = false;
      while (index < source.length) {
        const current = source[index++]!;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '"') break;
      }
      const raw = source.slice(start, index);
      try {
        tokens.push({ kind: 'string', value: JSON.parse(raw) as string });
      } catch {
        throw new GraphqlError('Invalid string literal');
      }
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_]/u.test(source[index]!)) index += 1;
      tokens.push({ kind: 'name', value: source.slice(start, index) });
      continue;
    }
    if (char === '-' || /[0-9]/u.test(char)) {
      const start = index++;
      while (index < source.length && /[0-9]/u.test(source[index]!)) index += 1;
      tokens.push({ kind: 'number', value: source.slice(start, index) });
      continue;
    }
    if ('!$():=@[]{}'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    throw new GraphqlError(`Unexpected character '${char}'`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private take(): Token {
    return this.tokens[this.index++]!;
  }

  private accept(value: string): boolean {
    if (this.peek().value !== value) return false;
    this.take();
    return true;
  }

  private expect(value: string): void {
    if (!this.accept(value)) throw new GraphqlError(`Expected '${value}'`);
  }

  private name(): string {
    const token = this.take();
    if (token.kind !== 'name') throw new GraphqlError('Expected a name');
    return token.value;
  }

  parse(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') operations.push(this.operation());
    if (operations.length === 0) throw new GraphqlError('Expected an operation');
    return operations;
  }

  private operation(): OperationNode {
    if (this.peek().value === '{') return { type: 'query', selection: this.selectionSet() };
    const operationToken = this.take();
    if (operationToken.kind !== 'name' || (operationToken.value !== 'query' && operationToken.value !== 'mutation')) {
      throw new GraphqlError('Expected query or mutation');
    }
    const operation: OperationNode = { type: operationToken.value, selection: [] };
    if (this.peek().kind === 'name') operation.name = this.name();
    if (this.accept('(')) {
      while (!this.accept(')')) {
        this.expect('$');
        this.name();
        this.expect(':');
        this.typeReference();
        if (this.accept('=')) this.value();
        while (this.accept('@')) {
          this.name();
          if (this.accept('(')) {
            while (!this.accept(')')) {
              this.name();
              this.expect(':');
              this.value();
            }
          }
        }
      }
    }
    operation.selection = this.selectionSet();
    return operation;
  }

  private typeReference(): void {
    if (this.accept('[')) {
      this.typeReference();
      this.expect(']');
    } else {
      this.name();
    }
    this.accept('!');
  }

  private selectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.accept('}')) {
      if (this.peek().kind === 'eof') throw new GraphqlError('Unterminated selection set');
      if (this.peek().kind === 'spread') {
        this.take();
        this.expect('on');
        const type = this.name();
        selections.push({ kind: 'fragment', type, selection: this.selectionSet() });
        continue;
      }
      let name = this.name();
      let alias = name;
      if (this.accept(':')) {
        alias = name;
        name = this.name();
      }
      const args: Record<string, ValueNode> = {};
      if (this.accept('(')) {
        while (!this.accept(')')) {
          const argName = this.name();
          this.expect(':');
          args[argName] = this.value();
        }
      }
      while (this.accept('@')) {
        this.name();
        if (this.accept('(')) {
          while (!this.accept(')')) {
            this.name();
            this.expect(':');
            this.value();
          }
        }
      }
      const selection = this.peek().value === '{' ? this.selectionSet() : [];
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    return selections;
  }

  private value(): ValueNode {
    if (this.accept('$')) return { kind: 'variable', name: this.name() };
    if (this.accept('[')) {
      const values: unknown[] = [];
      while (!this.accept(']')) values.push(this.resolveLiteral(this.value()));
      return { kind: 'literal', value: values };
    }
    if (this.accept('{')) {
      const value: Record<string, unknown> = {};
      while (!this.accept('}')) {
        const name = this.name();
        this.expect(':');
        value[name] = this.resolveLiteral(this.value());
      }
      return { kind: 'literal', value };
    }
    const token = this.take();
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'number') return { kind: 'literal', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value };
    }
    throw new GraphqlError('Expected a value');
  }

  private resolveLiteral(value: ValueNode): unknown {
    return value.kind === 'literal' ? value.value : value;
  }
}

interface ObjectRef {
  type: string;
  value: unknown;
}

interface FieldResult {
  type?: string;
  value: unknown;
  list?: boolean;
}

interface TypeShape {
  fields?: readonly string[];
  enumValues?: readonly string[];
}

const enumValues: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const typeFields: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  DefaultBranchRef: ['name'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequestChangedFiles: ['nodes'],
  PullRequestChangedFile: ['path'],
  __Type: ['name', 'fields', 'enumValues', 'kind'],
  __Field: ['name'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function idFor(type: string, repo: Repository, number?: number, comment?: number): string {
  const payload = type === 'Repository'
    ? `Repository:${repo.databaseId}`
    : type === 'IssueComment'
      ? `IssueComment:${repo.databaseId}:${comment ?? 0}`
      : `${type}:${repo.databaseId}:${number ?? 0}`;
  return Buffer.from(payload).toString('base64url');
}

function repoByDatabaseId(databaseId: number): Repository | undefined {
  return listRepos(VIEWER.login).find((repo) => repo.databaseId === databaseId);
}

function decodeId(id: unknown): { type: string; repo: Repository; number?: number; comment?: number } | undefined {
  if (typeof id !== 'string') return undefined;
  try {
    const payload = Buffer.from(id, 'base64url').toString('utf8');
    const parts = payload.split(':');
    const type = parts[0]!;
    const databaseId = Number(parts[1]);
    const repo = repoByDatabaseId(databaseId);
    if (!repo) return undefined;
    if (type === 'Repository') return { type, repo };
    if (type === 'Issue' || type === 'PullRequest') {
      const number = Number(parts[2]);
      return Number.isInteger(number) ? { type, repo, number } : undefined;
    }
    if (type === 'IssueComment') {
      const comment = Number(parts[2]);
      return Number.isInteger(comment) ? { type, repo, comment } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function objectRef(type: string, value: unknown): ObjectRef {
  return { type, value };
}

function asIssue(repo: Repository, number: number): IssueRecord | undefined {
  return repo.issues.get(number);
}

function asPull(repo: Repository, number: number): PullRecord | undefined {
  return repo.pulls.get(number);
}

function typeShape(name: string): TypeShape | null {
  const fields = typeFields[name];
  const values = enumValues[name];
  if (!fields && !values) return null;
  return { fields, enumValues: values };
}

function evaluateValue(node: ValueNode | undefined, variables: Record<string, unknown>): unknown {
  if (node === undefined) return undefined;
  const resolveNested = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolveNested);
    if (isRecord(value) && value.kind === 'variable' && typeof value.name === 'string') return variables[value.name];
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveNested(child)]));
    return value;
  };
  return node.kind === 'variable' ? variables[node.name] : resolveNested(node.value);
}

function argumentValues(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) result[name] = evaluateValue(node, variables);
  return result;
}

function createIssue(repo: Repository, title: unknown, body: unknown): IssueRecord {
  if (typeof title !== 'string') throw new GraphqlError('title must be a string');
  const number = repo.nextIssueNumber++;
  tickSeconds();
  const now = nowIso();
  const issue: IssueRecord = {
    id: number,
    number,
    title,
    body: typeof body === 'string' ? body : '',
    state: 'open',
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(number, issue);
  repo.issueLabelNames.set(number, []);
  return issue;
}

function createPull(repo: Repository, base: unknown, head: unknown, title: unknown): PullRecord {
  if (typeof base !== 'string' || typeof head !== 'string') throw new GraphqlError('baseRefName and headRefName must be strings');
  if (typeof title !== 'string') throw new GraphqlError('title must be a string');
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (!headSha || !baseSha) throw new GraphqlError('Head or base branch not found');
  if ([...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.head === head && pull.base === base)) {
    throw new GraphqlError('A pull request already exists for these branches');
  }
  const number = repo.nextIssueNumber++;
  tickSeconds();
  const now = nowIso();
  const pull: PullRecord = {
    id: number,
    number,
    title,
    body: '',
    state: 'open',
    createdAt: now,
    updatedAt: now,
    head,
    base,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.pulls.set(number, pull);
  return pull;
}

function resolveField(parent: ObjectRef, field: FieldNode, variables: Record<string, unknown>): FieldResult {
  const args = argumentValues(field, variables);
  const value = parent.value;
  switch (parent.type) {
    case 'Query': {
      if (field.name === 'viewer') return { type: 'User', value: VIEWER };
      if (field.name === 'repository') {
        const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return { type: 'Repository', value: repo ? objectRef('Repository', repo) : null };
      }
      if (field.name === 'node') {
        const decoded = decodeId(args.id);
        if (!decoded) return { value: null };
        if (decoded.type === 'Repository') return { type: 'Repository', value: objectRef('Repository', decoded.repo) };
        if (decoded.type === 'Issue') {
          const issue = asIssue(decoded.repo, decoded.number!);
          return { type: 'Issue', value: issue ? objectRef('Issue', { repo: decoded.repo, issue }) : null };
        }
        if (decoded.type === 'PullRequest') {
          const pull = asPull(decoded.repo, decoded.number!);
          return { type: 'PullRequest', value: pull ? objectRef('PullRequest', { repo: decoded.repo, pull }) : null };
        }
        return { value: null };
      }
      if (field.name === '__type') {
        const shape = typeShape(String(args.name ?? ''));
        const name = String(args.name ?? '');
        if (!shape) return { type: '__Type', value: null };
        return { type: '__Type', value: { name, shape } };
      }
      break;
    }
    case 'User':
      if (field.name === 'login') return { value: VIEWER.login };
      if (field.name === 'id') return { value: VIEWER.id };
      break;
    case 'Repository': {
      const repo = value as Repository;
      if (field.name === 'id') return { value: idFor('Repository', repo) };
      if (field.name === 'databaseId') return { value: repo.databaseId };
      if (field.name === 'name') return { value: repo.name };
      if (field.name === 'nameWithOwner') return { value: `${VIEWER.login}/${repo.name}` };
      if (field.name === 'owner') return { type: 'User', value: VIEWER };
      if (field.name === 'defaultBranchRef') {
        return { type: 'DefaultBranchRef', value: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null };
      }
      if (field.name === 'viewerPermission') return { value: 'ADMIN' };
      if (field.name === 'hasIssuesEnabled') return { value: true };
      if (field.name === 'issue') {
        const issue = asIssue(repo, Number(args.number));
        return { type: 'Issue', value: issue ? objectRef('Issue', { repo, issue }) : null };
      }
      if (field.name === 'pullRequest') {
        const pull = asPull(repo, Number(args.number));
        return { type: 'PullRequest', value: pull ? objectRef('PullRequest', { repo, pull }) : null };
      }
      if (field.name === 'issues') {
        let issues = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? args.states : args.states === undefined ? [] : [args.states];
        if (states.length > 0) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
        const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
        if (orderBy.direction === 'DESC') issues.reverse();
        const after = args.after;
        let offset = 0;
        if (typeof after === 'string') {
          try {
            const parsed = Number(Buffer.from(after, 'base64url').toString('utf8'));
            if (Number.isInteger(parsed) && parsed >= 0) offset = parsed;
          } catch {
            offset = 0;
          }
        }
        const first = args.first === undefined || args.first === null ? issues.length : Math.max(0, Math.floor(Number(args.first) || 0));
        const nodes = issues.slice(offset, offset + first).map((issue) => objectRef('Issue', { repo, issue }));
        const end = offset + nodes.length;
        return {
          type: 'IssueConnection',
          value: {
            nodes,
            pageInfo: { hasNextPage: end < issues.length, endCursor: nodes.length > 0 ? Buffer.from(String(end)).toString('base64url') : null },
          },
        };
      }
      if (field.name === 'pullRequests') {
        const pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
        const first = args.first === undefined || args.first === null ? pulls.length : Math.max(0, Math.floor(Number(args.first) || 0));
        return { type: 'PullRequestConnection', value: { nodes: pulls.slice(0, first).map((pull) => objectRef('PullRequest', { repo, pull })) } };
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = value as { repo: Repository; issue: IssueRecord };
      if (field.name === 'id') return { value: idFor('Issue', repo, issue.number) };
      if (field.name === 'number') return { value: issue.number };
      if (field.name === 'title') return { value: issue.title };
      if (field.name === 'state') return { value: issue.state.toUpperCase() };
      if (field.name === 'body') return { value: issue.body };
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = value as { repo: Repository; pull: PullRecord };
      if (field.name === 'id') return { value: idFor('PullRequest', repo, pull.number) };
      if (field.name === 'number') return { value: pull.number };
      if (field.name === 'title') return { value: pull.title };
      if (field.name === 'state') return { value: pull.merged ? 'MERGED' : pull.state.toUpperCase() };
      if (field.name === 'merged') return { value: pull.merged };
      if (field.name === 'headRefName') return { value: pull.head };
      if (field.name === 'baseRefName') return { value: pull.base };
      if (field.name === 'mergeable') return { value: pullMergeability(repo, pull) };
      if (field.name === 'files') {
        const files = diffFiles(repo, pull).map((file) => ({ path: String(file.filename) }));
        const first = args.first === undefined || args.first === null ? files.length : Math.max(0, Math.floor(Number(args.first) || 0));
        return { type: 'PullRequestChangedFiles', value: { nodes: files.slice(0, first) } };
      }
      break;
    }
    case 'DefaultBranchRef':
      if (field.name === 'name') return { value: (value as { name: string }).name };
      break;
    case 'IssueConnection':
      if (field.name === 'nodes') return { type: 'Issue', value: (value as { nodes: ObjectRef[] }).nodes, list: true };
      if (field.name === 'pageInfo') return { type: 'PageInfo', value: (value as { pageInfo: unknown }).pageInfo };
      break;
    case 'PullRequestConnection':
      if (field.name === 'nodes') return { type: 'PullRequest', value: (value as { nodes: ObjectRef[] }).nodes, list: true };
      break;
    case 'PageInfo':
      if (field.name === 'hasNextPage') return { value: (value as { hasNextPage: boolean }).hasNextPage };
      if (field.name === 'endCursor') return { value: (value as { endCursor: string | null }).endCursor };
      break;
    case 'PullRequestChangedFiles':
      if (field.name === 'nodes') return { type: 'PullRequestChangedFile', value: (value as { nodes: unknown[] }).nodes, list: true };
      break;
    case 'PullRequestChangedFile':
      if (field.name === 'path') return { value: (value as { path: string }).path };
      break;
    case '__Type': {
      const { name, shape } = value as { name: string; shape: TypeShape };
      if (field.name === 'name') return { value: name };
      if (field.name === 'fields') {
        return { type: '__Field', value: shape.fields?.map((fieldName) => ({ name: fieldName })) ?? null, list: !!shape.fields };
      }
      if (field.name === 'enumValues') {
        return { type: '__Field', value: shape.enumValues?.map((enumName) => ({ name: enumName })) ?? null, list: !!shape.enumValues };
      }
      if (field.name === 'kind') return { value: shape.enumValues ? 'ENUM' : 'OBJECT' };
      break;
    }
    case '__Field':
      if (field.name === 'name') return { value: (value as { name: string }).name };
      break;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field.name === 'issue') return { type: 'Issue', value: (value as { issue: ObjectRef | null }).issue };
      if (field.name === 'clientMutationId') return { value: (value as { clientMutationId: unknown }).clientMutationId };
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return { type: 'PullRequest', value: (value as { pullRequest: ObjectRef | null }).pullRequest };
      if (field.name === 'clientMutationId') return { value: (value as { clientMutationId: unknown }).clientMutationId };
      break;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return { type: 'CommentEdge', value: (value as { commentEdge: unknown }).commentEdge };
      if (field.name === 'clientMutationId') return { value: (value as { clientMutationId: unknown }).clientMutationId };
      break;
    case 'CommentEdge':
      if (field.name === 'node') return { type: 'IssueComment', value: (value as { node: unknown }).node };
      break;
    case 'IssueComment':
      if (field.name === 'id') {
        const comment = value as { repo: Repository; comment: { id: number } };
        return { value: idFor('IssueComment', comment.repo, undefined, comment.comment.id) };
      }
      if (field.name === 'body') return { value: (value as { comment: { body: string } }).comment.body };
      break;
    case 'Mutation': {
      const input = isRecord(args.input) ? args.input : {};
      const clientMutationId = input.clientMutationId;
      if (field.name === 'createIssue') {
        const decoded = decodeId(input.repositoryId);
        if (decoded?.type !== 'Repository') throw new GraphqlError('repositoryId is invalid');
        const issue = createIssue(decoded.repo, input.title, input.body);
        return { type: 'CreateIssuePayload', value: { issue: objectRef('Issue', { repo: decoded.repo, issue }), clientMutationId } };
      }
      if (field.name === 'closeIssue') {
        const decoded = decodeId(input.issueId);
        if (decoded?.type !== 'Issue') throw new GraphqlError('issueId is invalid');
        const issue = asIssue(decoded.repo, decoded.number!);
        if (!issue) throw new GraphqlError('Issue not found');
        issue.state = 'closed';
        tickSeconds();
        issue.updatedAt = nowIso();
        return { type: 'CloseIssuePayload', value: { issue: objectRef('Issue', { repo: decoded.repo, issue }), clientMutationId } };
      }
      if (field.name === 'createPullRequest') {
        const decoded = decodeId(input.repositoryId);
        if (decoded?.type !== 'Repository') throw new GraphqlError('repositoryId is invalid');
        const pull = createPull(decoded.repo, input.baseRefName, input.headRefName, input.title);
        return { type: 'CreatePullRequestPayload', value: { pullRequest: objectRef('PullRequest', { repo: decoded.repo, pull }), clientMutationId } };
      }
      if (field.name === 'mergePullRequest') {
        const decoded = decodeId(input.pullRequestId);
        if (decoded?.type !== 'PullRequest') throw new GraphqlError('pullRequestId is invalid');
        const pull = asPull(decoded.repo, decoded.number!);
        if (!pull) throw new GraphqlError('Pull request not found');
        mergePullRequest(decoded.repo, pull, typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE');
        return { type: 'MergePullRequestPayload', value: { pullRequest: objectRef('PullRequest', { repo: decoded.repo, pull }), clientMutationId } };
      }
      if (field.name === 'addComment') {
        const decoded = decodeId(input.subjectId);
        if (decoded?.type !== 'Issue' || typeof input.body !== 'string') throw new GraphqlError('subjectId and body are invalid');
        const issue = asIssue(decoded.repo, decoded.number!);
        if (!issue) throw new GraphqlError('Issue not found');
        const id = decoded.repo.nextCommentId++;
        tickSeconds();
        const comment = { id, body: input.body, createdAt: nowIso() };
        const comments = decoded.repo.comments.get(issue.number) ?? [];
        comments.push(comment);
        decoded.repo.comments.set(issue.number, comments);
        return {
          type: 'AddCommentPayload',
          value: { commentEdge: { node: { repo: decoded.repo, comment } }, clientMutationId },
        };
      }
      break;
    }
  }
  throw new GraphqlError(`Field '${field.name}' doesn't exist on type '${parent.type}'`);
}

function evaluateSelections(
  parent: ObjectRef,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.type === parent.type) Object.assign(result, evaluateSelections(parent, selection.selection, variables, errors));
      continue;
    }
    if (selection.name === '__typename') {
      result[selection.alias] = parent.type;
      continue;
    }
    try {
      const resolved = resolveField(parent, selection, variables);
      if (resolved.value === null || resolved.value === undefined) {
        result[selection.alias] = null;
      } else if (resolved.type) {
        if (resolved.list) {
          const entries = resolved.value as unknown[];
          result[selection.alias] = entries.map((entry) => entry === null ? null : evaluateSelections(
            (isRecord(entry) && typeof entry.type === 'string' && 'value' in entry)
              ? entry as ObjectRef
              : objectRef(resolved.type!, entry),
            selection.selection,
            variables,
            errors,
          ));
        } else {
          const child = isRecord(resolved.value) && typeof resolved.value.type === 'string' && 'value' in resolved.value
            ? resolved.value as ObjectRef
            : objectRef(resolved.type, resolved.value);
          result[selection.alias] = evaluateSelections(child, selection.selection, variables, errors);
        }
      } else {
        result[selection.alias] = resolved.value;
      }
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : String(error) });
      result[selection.alias] = null;
    }
  }
  return result;
}

function executeOperation(operation: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const type = operation.type === 'query' ? 'Query' : 'Mutation';
  return {
    data: evaluateSelections(objectRef(type, null), operation.selection, variables, errors),
    errors,
  };
}

function responseFor(request: unknown): unknown {
  if (!isRecord(request) || typeof request.query !== 'string') {
    return { data: null, errors: [{ message: 'Request must contain a query string' }] };
  }
  try {
    const operations = new Parser(request.query).parse();
    const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
    const operation = operationName === undefined
      ? operations[0]
      : operations.find((candidate) => candidate.name === operationName);
    if (!operation) throw new GraphqlError(`Unknown operation named '${operationName ?? ''}'`);
    const variables = isRecord(request.variables) ? request.variables : {};
    const result = executeOperation(operation, variables);
    return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

export function handleGraphql(
  res: ServerResponse,
  body: unknown,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
): boolean {
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(responseFor));
    return true;
  }
  sendJson(res, 200, responseFor(body));
  return true;
}
