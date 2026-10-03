# Knowledge Inbox Zero

Aggressively reduce your reading backlog. Paste a messy pile of URLs, and Knowledge Inbox Zero tells you the **small subset that actually deserves your attention** — and explains, per document, **what is genuinely new** and **why it matters to you specifically**.

It optimizes for **attention saved**, not content stored.

> **Not** a bookmark manager. **Not** a read-it-later app. **Not** an RSS reader. The one question it answers is: _what deserves this user's attention, and why?_

## The idea: Marginal Knowledge Value

A document's worth is not its objective quality — it's the **additional** value it gives _you_, given what you already know, what you're researching, and what you've already processed. A great article about something you already understand has near-zero marginal value.

Every analyzed document gets:

- A single **recommendation state** — `READ`, `SKIM`, or `SKIP`.
- A numeric **MKV score** (0–100) built from relevance, novelty, redundancy, and freshness.
- Advisory **tags** — `REDUNDANT`, `OUTDATED`, `REFERENCE`, `FRESH`.
- A written **explanation** (the primary output; scores are supporting detail).

## How it works

1. **Profile** — You describe your knowledge: high/medium interests, what you're currently researching, what you already know, content types to avoid, and optional free-text context.
2. **Add content** — Paste newline-separated URLs (up to 500) as one persistent **batch**. The request returns in under 3 seconds; nothing blocks while URLs are analyzed.
3. **Async analysis** — Each URL is canonicalized, de-duplicated, fetched best-effort, and run through the pipeline. A bad or unreachable URL never fails the batch; it still produces a recommendation from whatever was obtained.
4. **Library** — Documents are grouped by recommendation with per-state counts, and **attention saved** is surfaced as the headline metric. Open any document for its full explanation.

## Architecture

Serverless-first on AWS, deterministic-first by design. The LLM is invoked **only** for structured extraction and the written explanation — everything else (canonicalization, dedup, metadata, all MKV math) is pure deterministic code, property-tested once in `@app/shared` and reused by both the API and the worker.

```
Web App (React + Vite + PWA)
   │  HTTPS + Cognito id token
   ▼
API Gateway HTTP API v2  ──(JWT authorizer)──►  Lambdas (Node 22, ARM64)
   ├─ profile      /profile
   ├─ imports      /imports, /imports/{batchId}        ── enqueue ──►  SQS ──► analysis-worker ──► Bedrock
   ├─ documents    /documents, /documents/{documentId}                          │          └─► S3 (large extracted content)
   └─ users        /users, /users/me, /users/{username}                         └─► DynamoDB (atomic counters)
                                                                     SQS DLQ ◄── (after 3 failed receives)
```

- **Sync handlers** (256 MB, 10 s): `profile`, `imports`, `documents`, `users`. Deterministic; never call Bedrock.
- **`analysis-worker`** (1024 MB, 120 s, reserved concurrency 5): SQS-triggered, the full per-document pipeline — fetch → [Mozilla Readability](https://github.com/mozilla/readability) extraction → Bedrock structured extraction → MKV scoring → Bedrock explanation → persist → atomic DynamoDB counter updates. The **only** component that calls Bedrock or writes extracted content to S3.
- **Storage**: DynamoDB (PAY_PER_REQUEST, one table per entity — `profiles`, `batches`, `documents`, `users`) + a private S3 bucket for extracted content over 300 KB.
- **AI**: Amazon Bedrock on-demand, single configurable model via `BEDROCK_MODEL_ID` (default `anthropic.claude-3-5-sonnet-20240620-v1:0`). No vector DB in V1 — novelty/redundancy are computed deterministically from extracted concepts.

## Tech stack

- **Frontend**: React 18 + Vite 8 + TypeScript + Tailwind 3.4, PWA (`vite-plugin-pwa`, `registerType: "prompt"`), AWS Amplify (Cognito) auth, `react-router-dom` v6. Shared API client with retry + exponential backoff.
- **Backend**: AWS Lambda (Node 22, ARM64) in TypeScript ESM, AWS SDK v3 (DynamoDB, SQS, S3, Bedrock Runtime, Cognito), `zod` validation, `aws-jwt-verify`, `@mozilla/readability` + `jsdom`. One handler per domain.
- **Shared** (`@app/shared`): types, constants, zod schemas, and all pure deterministic MKV logic.
- **Infra** (`infra/cdk`): AWS CDK (`aws-cdk-lib` ^2.258) — `storage` (DynamoDB + content bucket), `auth` (Cognito + TOTP MFA), `api` (HTTP API v2 + Lambdas + SQS/DLQ + Bedrock IAM), `frontend` (private S3 + CloudFront with OAC and security headers).
- **Quality**: ESLint 9, Prettier, Stylelint, husky + lint-staged, Jest (backend, with `fast-check` property tests), Vitest (frontend). CI pipeline via GitHub Actions + OIDC.

Default region `eu-south-2` (configurable). Environment: `prod` (the `test` environment is retired for now).

## Project layout

```
.
├── shared/             # @app/shared — types, schemas, pure MKV logic (build first)
├── frontend/           # React SPA — pages: Profile, Add Content, Library, Document Detail
├── backend/            # Lambda handlers: profile, imports, documents, analysis-worker, users
├── infra/cdk/          # CDK stacks: storage, auth, api, frontend
├── scripts/            # deploy.sh, create-user.sh, set-password.sh, dev-frontend.sh
├── .github/workflows/  # pipeline.yml (lint → test → build → deploy)
└── Makefile            # unified command interface
```

## Getting started

> **New here?** [INSTALL.md](INSTALL.md) walks through both ways to use the app:
> using the hosted web app (zero setup), or self-hosting on your own AWS account.
> This section is the quick reference.

Prerequisites: Node.js ≥ 22, an AWS account, the AWS CLI configured, and the AWS CDK bootstrapped in your account/region. Amazon Bedrock model access must be enabled for the configured model.

```bash
make install                         # npm ci — clean, reproducible install
make build                           # build shared + backend + frontend
```

### Deploy and create your first user

```bash
cdk bootstrap aws://<account>/<region>              # once per account/region
make deploy ENV=prod                                # storage + auth + api + frontend
make create-admin EMAIL=you@email.com PASSWORD='Temp.123!' ENV=prod
```

On first login Cognito requires changing the password and setting up TOTP MFA. User creation is invite-only.

### Run the frontend locally

```bash
make dev-env     # populate frontend/.env from SSM (needs AWS creds; run once after deploy)
make dev         # Vite dev server against the deployed backend
```

## Everyday commands

Run from the repo root — `make help` lists everything.

```bash
make validate                        # build shared + lint + css + typecheck + format + tests
make test                            # backend (Jest) + frontend (Vitest)
make fix                             # auto-fix lint + css + formatting
make typecheck                       # type-check all workspaces

make deploy ENV=prod                 # infra + frontend (skips unchanged components)
make deploy-backend ENV=prod         # CDK only
make deploy-frontend ENV=prod        # build + S3 sync + CloudFront invalidation
make deploy ENV=prod FORCE_DEPLOY=true

make logs-lambdas ENV=test TYPE=errors   # tail Lambda logs (MINS=30 default)
make clean                               # remove build artifacts
```

`scripts/deploy.sh` fingerprints version-controlled files and skips components that haven't changed (override with `FORCE_DEPLOY=true`).

### User management (Cognito)

```bash
make create-user  EMAIL=x@email.com PASSWORD='Temp.123!' ROLE=USER ENV=test
make set-password EMAIL=x@email.com PASSWORD='New.Secure123!' ENV=test
```

## Configuration

- `BEDROCK_MODEL_ID` — the Bedrock foundation model (set at deploy time; a redeploy switches models without code changes).
- `EMBEDDINGS_ENABLED` — Tier B semantic novelty via embeddings; defaults to `false`. V1 uses the deterministic concept-based path.
- `knowledge-inbox-zero` and `eu-south-2` — repo-wide placeholders for your project slug and AWS region. (Internal `@app/*` package names are fixed and not renamed.)

## CI/CD

`.github/workflows/pipeline.yml` runs `lint → test → build` (including `cdk synth`) on every push, then deploys to `test` on non-`main` branches and `prod` on `main` via OIDC (no stored secrets). Configure the `AWS_ROLE_FOR_GITHUB_DEPLOYMENTS` repo variable and the `test`/`prod` environments; until that variable is set, deploy jobs are skipped (not failed), so CI stays green on a fresh clone.

## Scope

- **V1 (built)**: profile, paste-URL import, async analysis, MKV scoring, recommendation + explanation, persistent library, web UI, per-user privacy.
- **Optional stretch (behind flags)**: client-side bookmark-HTML import, embeddings-based semantic novelty, section-level read/skip guidance, user-selectable Bedrock model.
- **Out of scope for V1**: full bookmark manager, reader/highlights/annotations, RSS/newsletter ingestion, mobile apps, browser extensions, collaborative libraries, generic chatbot over the library, knowledge graphs, large-scale vector infrastructure.

## License

MIT — see [LICENSE](LICENSE).
