# Tech Stack

## Build system

- **npm workspaces** monorepo. Workspaces: `shared`, `frontend`, `backend`, `infra/cdk`.
- **Node.js >= 22** (Lambdas run on Node 22, ARM64).
- **TypeScript 5.4** everywhere, ESM modules (`"type": "module"`). Shared `tsconfig.base.json`.
- A unified **Makefile** wraps the npm scripts and `scripts/` helpers. Prefer `make` targets for common flows.

## Stack by workspace

- **`shared` (`@app/shared`)**: TypeScript types, constants, zod schemas, and all **pure deterministic logic** (URL canonicalization, dedup keys, concept-set math, MKV scoring, recommendation-state mapping) shared between front and back and property-tested once. Must be built before backend/frontend.
- **`frontend` (`@app/frontend`)**: React 18 + Vite 8 + Tailwind 3.4, PWA via `vite-plugin-pwa` (`registerType: "prompt"`), AWS Amplify (Cognito) auth, `react-router-dom` v6. Shared API client (`lib/api.ts`) with retry + exponential backoff. Tests with Vitest + Testing Library + jsdom.
- **`backend` (`@app/backend`)**: AWS Lambda in TypeScript ESM, AWS SDK v3, validation with `zod`, JWT verification with `aws-jwt-verify`. One handler per domain. Key deps:
  - `@aws-sdk/client-dynamodb` + `lib-dynamodb` — persistence.
  - `@aws-sdk/client-sqs` — enqueue analysis messages.
  - `@aws-sdk/client-s3` — offloaded extracted content (>300 KB).
  - `@aws-sdk/client-bedrock-runtime` — structured extraction + written explanation (worker only).
  - `@aws-sdk/client-cognito-identity-provider` — user management.
  - `@mozilla/readability` + `jsdom` — main-content extraction from arbitrary HTML (no headless browser).
  - Tests with Jest + ts-jest; property tests with `fast-check`.
- **`infra/cdk` (`@app/infra`)**: AWS CDK (`aws-cdk-lib` ^2.258), esbuild/`NodejsFunction` for Lambda bundling. Stacks: `storage` (4 DynamoDB tables + private content S3 bucket), `auth` (Cognito + TOTP MFA), `api` (HTTP API v2 + Lambdas + SQS queue/DLQ + Bedrock IAM), `frontend` (S3 + CloudFront).

## Runtime architecture

- **API**: API Gateway **HTTP API v2** with a Cognito JWT authorizer. Synchronous handlers run at 256 MB / 10 s timeout.
- **Async analysis**: `imports` enqueues one **SQS** message per new document; the **`analysis-worker`** Lambda (1024 MB, 120 s timeout, reserved concurrency 5, partial-batch-failure reporting) consumes them. Queue visibility timeout 720 s (≥6× worker timeout); DLQ after `maxReceiveCount = 3`.
- **AI**: Amazon **Bedrock** on-demand, single configurable model via `BEDROCK_MODEL_ID` (default `anthropic.claude-3-5-sonnet-20240620-v1:0`). Invoked only by the worker, only for extraction + explanation. `EMBEDDINGS_ENABLED` defaults to `false` (Tier B).
- **Storage**: DynamoDB PAY_PER_REQUEST (one table per entity, GSIs for owner/state/batch, atomic `ADD` counters), private S3 content bucket for large extracted text.

## Tooling & quality

- **ESLint 9** (flat config, `typescript-eslint`), **Prettier**, **Stylelint** for CSS.
- **husky** + **lint-staged** on pre-commit (eslint --fix + prettier on staged files).
- CI: `.github/workflows/pipeline.yml` runs `lint → test → build` (incl. `cdk synth`); deploys to `prod` on `main` via OIDC. The `test` deploy job is commented out (test environment retired for now).

## Common commands

Run from the repo root. `make help` lists all targets.

### Install & develop

```bash
make install         # npm ci (clean, reproducible install from the lockfile)
make dev             # run frontend locally (Vite, no AWS creds)
make dev-env         # populate frontend/.env from SSM (needs creds, run once after deploy)
```

### Build

```bash
make build           # build shared + backend + frontend
make build-shared    # build only shared (required before the rest)
```

### Quality (run these after changes; keep them green)

```bash
make validate        # build shared + lint + css + typecheck + format check + tests
make quality-check   # same as validate but without tests
make test            # backend (Jest) + frontend (Vitest) tests
make lint            # lint all workspaces
make fix             # auto-fix lint + css + formatting
make typecheck       # type-check all workspaces
```

### Deploy (deploy.sh skips unchanged components unless FORCE_DEPLOY=true)

```bash
make deploy ENV=prod              # infra + frontend
make deploy-backend ENV=prod      # CDK only
make deploy-frontend ENV=prod     # frontend only (build + S3 sync + invalidation)
make deploy ENV=prod FORCE_DEPLOY=true
```

### Users (Cognito, invite-only)

```bash
make create-admin EMAIL=you@email.com PASSWORD='Temp.123!' ENV=test
make create-user  EMAIL=x@email.com PASSWORD='Temp.123!' ROLE=USER ENV=test
make set-password EMAIL=x@email.com PASSWORD='New.Secure123!' ENV=test
```

### Ops

```bash
make logs-lambdas ENV=test TYPE=errors   # tail Lambda logs (profile, imports, documents, analysis-worker, users; MINS=30 default)
make clean                                # remove build artifacts
```

## Kiro tooling (MCP + agents)

- **MCP — `aws-docs`** (`.kiro/settings/mcp.json`): the AWS Documentation MCP server
  (`awslabs.aws-documentation-mcp-server` via `uvx`). Use it to check current AWS
  guidance while implementing serverless/Bedrock code instead of relying only on
  model memory — e.g. confirm the recommended Bedrock Runtime API (Converse vs
  `InvokeModel`) before changing `backend/src/lib/bedrock.ts`, or verify DynamoDB
  GSI / SQS / CDK construct options. Requires `uv`/`uvx` on the PATH.
- **Agent — `serverless-reviewer`** (`.kiro/agents/serverless-reviewer.md`): a
  read-only reviewer that checks a change against the approved spec, the steering
  architecture principles, AWS cost posture, and repo conventions. Invoke it after
  a vertical slice, e.g. "Switch to serverless-reviewer and review the imports
  handler change." It reports findings by severity; it does not implement.

## Rules

- After a batch of changes, keep `npm run build` and `npm run validate` green.
- Do not add new libraries without justification; prefer what's already in the stack.
- Invoke Bedrock only for extraction and explanation; keep everything else deterministic.
- On Windows the Makefile helpers are shell scripts; the underlying `npm run` scripts still work directly if `make`/bash is unavailable.
