# Product

**Knowledge Inbox Zero** aggressively reduces a user's reading/knowledge backlog. Given a messy pile of URLs and a persistent personal knowledge profile, it identifies the small subset of documents that genuinely deserve attention and explains, per document, **what is materially new** and **why it matters to this specific user right now**.

The product optimizes for **attention saved**, not content stored. Its central idea is **Marginal Knowledge Value (MKV)**: a document's worth is not its objective quality but the additional value it provides _to this user_, given what they already know, what they are researching, and what they have already processed. A well-written article can have near-zero marginal value to a user who already knows its content.

## What it is not

- Not a bookmark manager
- Not a read-it-later app
- Not an RSS reader
- Not a general knowledge base

Every product decision answers one question: **"What deserves this user's attention and why?"**

## Core workflow (V1)

1. The user creates a **knowledge profile**: high/medium interests, currently-researching topics, already-known topics, content types to avoid, and optional free-text context.
2. The user pastes a list of URLs (one per line) into a persistent **batch** (up to 500 URLs).
3. Each URL is canonicalized, de-duplicated, fetched best-effort, and analyzed into structured info (topics, concepts, claims, difficulty, summary).
4. Each document is scored for **Marginal Knowledge Value** against the profile and previously analyzed concepts (relevance, novelty, redundancy, freshness).
5. Each document gets exactly one **recommendation state** (`READ` / `SKIM` / `SKIP`), a numeric MKV score, advisory **tags** (`REDUNDANT`, `OUTDATED`, `REFERENCE`, `FRESH`), and a written **explanation**.
6. The **library** groups documents by recommendation with per-state counts and surfaces **attention saved** as the primary metric; the **detail** view shows the explanation.

## Recommendation taxonomy

- **States** (exactly one per document): `READ`, `SKIM`, `SKIP`.
- **Tags** (orthogonal, advisory, zero or more): `REDUNDANT`, `OUTDATED`, `REFERENCE`, `FRESH`.

## Scope tiers

- **Tier A (V1, built):** profile, paste-URL import, async analysis, per-document MKV scoring, recommendation + explanation, persistent library, web UI (Profile / Add Content / Library / Detail), per-user privacy.
- **Tier B (optional stretch, behind flags):** client-side bookmark-HTML import, embeddings-based semantic novelty (`EMBEDDINGS_ENABLED`, defaults off), section-level read/skip guidance, user-selectable Bedrock model.
- **Tier C (out of scope for V1):** full bookmark manager, reader/highlights/annotations, RSS/newsletter ingestion, mobile apps, browser extensions, social/collaborative libraries, generic chatbot over the library, knowledge graphs, large-scale vector infrastructure.

## Key behaviors to preserve

- **Deterministic-first.** Canonicalization, dedup, metadata, and all MKV math are deterministic. Bedrock is invoked **only** for structured extraction and the written explanation.
- **Never hold a request open.** Import returns within 3 seconds; all multi-document analysis runs asynchronously via SQS + a worker Lambda. The UI polls batch progress.
- **Graceful degradation.** A bad URL never fails the batch; the system still produces a recommendation from whatever it obtained (even metadata-only).
- **Per-user privacy.** Every read/write is scoped to the authenticated Cognito `sub`.

## Environments & regions

- Environment: `prod` (the `test` environment is retired for now).
- Default region: `eu-south-2` (configurable via the `eu-south-2` placeholder).
- Two template placeholders remain repo-wide: `knowledge-inbox-zero` and `eu-south-2`. Internal package names use the fixed `@app/*` scope and are not renamed.
