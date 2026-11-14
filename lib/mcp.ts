import type { ServerResponse } from 'node:http';
import { mergePullRequest } from './merge.ts';
import { createRepo, getRepo, nowIso, tickSeconds, VIEWER } from './store.ts';
import type { IssueRecord, PullRecord, Repository } from './store.ts';

type JsonRecord = Record<string, unknown>;

const serverInfo = Object.freeze({ name: 'forge', version: '1.0.0' });
const legacyVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const tools = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and repository name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredArgs(name: string): readonly string[] | undefined {
  return tools.find((tool) => tool.name === name)?.inputSchema.required;
}

function repoJson(repo: Repository): JsonRecord {
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

function issueJson(issue: IssueRecord): JsonRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  };
}

function pullJson(pull: PullRecord): JsonRecord {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: { ref: pull.head },
    base: { ref: pull.base },
  };
}

function createIssue(repo: Repository, title: string, body: unknown): IssueRecord {
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

function createPull(repo: Repository, args: JsonRecord): PullRecord {
  const head = args.head;
  const base = args.base;
  const title = args.title;
  if (typeof head !== 'string' || typeof base !== 'string') throw new Error('head and base must be strings');
  if (typeof title !== 'string') throw new Error('title must be a string');
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (!baseSha || !headSha) throw new Error('Head or base branch not found');
  if ([...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.head === head && pull.base === base)) {
    throw new Error('A pull request already exists for these branches');
  }
  const number = repo.nextIssueNumber++;
  tickSeconds();
  const now = nowIso();
  const pull: PullRecord = {
    id: number,
    number,
    title,
    body: typeof args.body === 'string' ? args.body : '',
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

function executeTool(name: string, args: JsonRecord): unknown {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      if (typeof args.name !== 'string' || args.name.length === 0) throw new Error('name is required');
      const repo = createRepo(owner, args.name, {
        description: typeof args.description === 'string' ? args.description : '',
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      return repoJson(repo);
    }
    case 'get_repo': {
      const repo = getRepo(owner, repoName);
      if (!repo) throw new Error('Not Found');
      return repoJson(repo);
    }
    case 'create_issue': {
      const repo = getRepo(owner, repoName);
      if (!repo) throw new Error('Not Found');
      if (typeof args.title !== 'string') throw new Error('title is required');
      return issueJson(createIssue(repo, args.title, args.body));
    }
    case 'list_issues': {
      const repo = getRepo(owner, repoName);
      if (!repo) throw new Error('Not Found');
      const state = args.state;
      const issues = [...repo.issues.values()].filter((issue) =>
        state === undefined || state === 'all' || issue.state === state,
      );
      return issues.map(issueJson);
    }
    case 'create_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) throw new Error('Not Found');
      return pullJson(createPull(repo, args));
    }
    case 'merge_pull_request': {
      const repo = getRepo(owner, repoName);
      if (!repo) throw new Error('Not Found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error('Pull request not found');
      const result = mergePullRequest(repo, pull);
      return { merged: true, sha: result.sha };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function toolResult(value: unknown, isError = false): JsonRecord {
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text: text ?? 'null' }],
    structuredContent: value,
    isError,
  };
}

function rpcError(id: unknown, code: number, message: string): JsonRecord {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function responseFor(request: unknown): { status: number; body: unknown } {
  if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return { status: 200, body: rpcError(isRecord(request) ? request.id : null, -32600, 'Invalid Request') };
  }
  const id = request.id;
  const params = isRecord(request.params) ? request.params : {};
  if (request.method === 'notifications/initialized' && id === undefined) return { status: 202, body: undefined };
  if (id === undefined) return { status: 202, body: undefined };
  if (request.method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        },
      },
    };
  }
  if (request.method === 'initialize') {
    const requested = params.protocolVersion;
    const protocolVersion = typeof requested === 'string' && legacyVersions.has(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo },
      },
    };
  }
  if (request.method === 'tools/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { tools } } };
  }
  if (request.method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string' || !tools.some((tool) => tool.name === name)) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool '${String(name ?? '')}'`) };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const missing = (requiredArgs(name) ?? []).filter((key) => args[key] === undefined || args[key] === null);
    if (missing.length > 0) {
      const result = toolResult({ error: `Missing required arguments: ${missing.join(', ')}` }, true);
      return { status: 200, body: { jsonrpc: '2.0', id, result } };
    }
    try {
      return { status: 200, body: { jsonrpc: '2.0', id, result: toolResult(executeTool(name, args)) } };
    } catch (error) {
      const result = toolResult({ error: error instanceof Error ? error.message : String(error) }, true);
      return { status: 200, body: { jsonrpc: '2.0', id, result } };
    }
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${request.method}`) };
}

export function handleMcp(
  res: ServerResponse,
  body: unknown,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
): boolean {
  const response = responseFor(body);
  if (response.status === 202) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return true;
  }
  sendJson(res, response.status, response.body);
  return true;
}
