# GitHub-compatible forge

This project is a small, standalone GitHub-compatible forge implemented in one Node.js process. It keeps repository metadata and Git objects in memory and exposes the protocol surfaces needed by the make.fun GitHub Core Clone competition.

## Surfaces

- **Git Smart HTTP** serves upload-pack and receive-pack advertisements and requests, including shallow fetches and pushes.
- **REST v3** provides repository, Git contents/ref, issue, pull request, and comment endpoints.
- **GraphQL** provides the competition's query and mutation subset.
- **MCP** exposes repository and issue tools over JSON-RPC.

All surfaces share the same in-process store, so repository and issue changes are visible across protocols. `GET /healthz` is an unauthenticated readiness probe; forge API routes require the configured bearer token.

## Run

The competition entry registers an ephemeral HTTP port with the environment and then waits for its completion signal:

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 \
MAKEFUN_SHOP_TOKEN=your-token \
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must point to an environment that implements `/register` and `/done`. The forge listens on the port assigned by the operating system; the environment routes requests to it after registration.

## Architecture

- `main.ts` owns the entry lifecycle: listen, register the port, wait for `/done`, and shut down.
- `app.ts` creates the HTTP server, authenticates API requests, handles JSON bodies, and routes requests to the protocol handlers.
- `lib/store.ts` owns the shared in-memory repository, issue, pull request, and Git-object maps, along with deterministic identifiers and timestamps.
- `lib/gitobj.ts` parses and builds Git objects, packs, and pkt-lines.
- `lib/gitproto.ts` implements Git Smart HTTP upload-pack and receive-pack.
- `lib/rest.ts` implements the REST v3 routes and repository file operations.
- `lib/graphql.ts` parses and executes the supported GraphQL subset.
- `lib/mcp.ts` implements JSON-RPC discovery and forge tools.
- `lib/merge.ts` handles pull-request merge and mergeability operations.

## Determinism

The forge uses a fixed viewer identity, monotonically assigned repository and issue identifiers, and a logical timestamp advanced by state changes instead of wall-clock timestamps. Git object IDs are content-addressed SHA-1 hashes. The competition's request fixtures and benchmark inputs are seeded by the harness; the forge does not use randomness to create repository state. Request IDs are sequential within the process.
