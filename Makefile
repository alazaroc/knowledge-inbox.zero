# ─────────────────────────────────────────────────────────────────────────────
# knowledge-inbox-zero — Makefile
# Thin wrappers over the npm scripts and the scripts/ helpers.
# Environments: test | prod.  Default is prod (test env retired for now).
# Overridable variables:  make deploy ENV=prod FORCE_DEPLOY=true
# ─────────────────────────────────────────────────────────────────────────────

PROJECT      := knowledge-inbox-zero
REGION       ?= eu-south-2
PROFILE      ?= webs
ENV          ?= prod
FORCE_DEPLOY ?= false

# create-user / create-admin (create-user.sh uses positional args: EMAIL PASSWORD ROLE)
EMAIL    ?=
PASSWORD ?=
ROLE     ?= USER

# logs-lambdas
MINS ?= 30
TYPE ?= all   # all | errors

# Base names of the Lambdas (functionName = $(PROJECT)-<base>-$(ENV))
LAMBDAS := profile imports documents analysis-worker users

.DEFAULT_GOAL := help
.PHONY: help install dev dev-env build build-shared \
        test lint lint-fix fix typecheck format quality-check validate \
        deploy deploy-backend deploy-frontend \
        create-user create-admin set-password logs-lambdas aws-credentials clean

## help: show this help
help:
	@echo "$(PROJECT) — available commands:"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed -E 's/^## /  /'
	@echo ""
	@echo "Examples:"
	@echo "  make deploy ENV=prod FORCE_DEPLOY=true"
	@echo "  make create-admin EMAIL=x@y.com PASSWORD=Secret123!"
	@echo "  make logs-lambdas MINS=30 TYPE=errors"

# ── Development ──────────────────────────────────────────────────────────────

## install: install dependencies from the lockfile (clean, reproducible)
install:
	npm ci

## dev: run the frontend locally (Vite, reads frontend/.env — no AWS credentials)
dev:
	npm run dev -w frontend

## dev-env: fill frontend/.env with endpoints from SSM (needs credentials; run once after deploying)
dev-env:
	ENV=$(ENV) ./scripts/dev-frontend.sh

## build: build shared + backend + frontend
build:
	npm run build

## build-shared: build only the shared package (required before the rest)
build-shared:
	npm run build:shared

# ── Quality ──────────────────────────────────────────────────────────────────

## test: run tests (backend + frontend)
test:
	npm test

## lint: run the linter across all workspaces
lint:
	npm run lint

## lint-fix: auto-fix lint problems
lint-fix:
	npm run lint:fix

## fix: lint:fix + css:fix + format (auto-fix everything fixable)
fix:
	npm run fix

## typecheck: type-check all workspaces
typecheck:
	npm run typecheck

## format: format the code with Prettier
format:
	npm run format

## quality-check: lint + css + typecheck + format check (no tests)
quality-check:
	npm run quality:check

## validate: build shared + lint + css + typecheck + format check + test
validate:
	npm run validate

# ── Deployment ───────────────────────────────────────────────────────────────
# deploy.sh detects changes by hash; skips unchanged components unless FORCE_DEPLOY=true.

## deploy: deploy everything (infra + frontend)
deploy:
	AWS_PROFILE=$(PROFILE) AWS_REGION=$(REGION) ENV=$(ENV) FORCE_DEPLOY=$(FORCE_DEPLOY) ./scripts/deploy.sh

## deploy-backend: deploy backend+infra only (CDK)
deploy-backend:
	AWS_PROFILE=$(PROFILE) AWS_REGION=$(REGION) ENV=$(ENV) FORCE_DEPLOY=$(FORCE_DEPLOY) ./scripts/deploy.sh backend

## deploy-frontend: deploy frontend only (build + S3 sync + invalidation)
deploy-frontend:
	AWS_PROFILE=$(PROFILE) AWS_REGION=$(REGION) ENV=$(ENV) FORCE_DEPLOY=$(FORCE_DEPLOY) ./scripts/deploy.sh frontend

# ── Users (Cognito) ──────────────────────────────────────────────────────────

## create-user: create a user (EMAIL, PASSWORD, [ROLE=USER])
create-user:
	@test -n "$(EMAIL)"    || (echo "Missing EMAIL=..."    && exit 1)
	@test -n "$(PASSWORD)" || (echo "Missing PASSWORD=..." && exit 1)
	ENV=$(ENV) ./scripts/create-user.sh "$(EMAIL)" "$(PASSWORD)" "$(ROLE)"

## create-admin: create a user with the ADMIN role (EMAIL, PASSWORD)
create-admin:
	@test -n "$(EMAIL)"    || (echo "Missing EMAIL=..."    && exit 1)
	@test -n "$(PASSWORD)" || (echo "Missing PASSWORD=..." && exit 1)
	ENV=$(ENV) ./scripts/create-user.sh "$(EMAIL)" "$(PASSWORD)" ADMIN

## set-password: set a PERMANENT password for an existing user (EMAIL, PASSWORD)
set-password:
	@test -n "$(EMAIL)"    || (echo "Missing EMAIL=..."    && exit 1)
	@test -n "$(PASSWORD)" || (echo "Missing PASSWORD=..." && exit 1)
	ENV=$(ENV) ./scripts/set-password.sh "$(EMAIL)" "$(PASSWORD)"

# ── Operations / AWS ─────────────────────────────────────────────────────────

## logs-lambdas: tail the Lambda logs (MINS=30, TYPE=all|errors)
logs-lambdas:
	@for fn in $(LAMBDAS); do \
	  group="/aws/lambda/$(PROJECT)-$$fn-$(ENV)"; \
	  echo "── $$group ──"; \
	  if [ "$(TYPE)" = "errors" ]; then \
	    aws logs tail "$$group" --since $(MINS)m --region $(REGION) \
	      --filter-pattern '?ERROR ?Error ?error ?Exception ?Timeout' 2>/dev/null || true; \
	  else \
	    aws logs tail "$$group" --since $(MINS)m --region $(REGION) 2>/dev/null || true; \
	  fi; \
	done

## aws-credentials: propagate AWS_ACCESS_KEY_ID/SECRET/TOKEN from the env to the default profile
aws-credentials:
	@if [ -z "$$AWS_ACCESS_KEY_ID" ] || [ -z "$$AWS_SECRET_ACCESS_KEY" ]; then \
		echo "❌ Export the variables first:"; \
		echo "  export AWS_ACCESS_KEY_ID=\"...\""; \
		echo "  export AWS_SECRET_ACCESS_KEY=\"...\""; \
		echo "  export AWS_SESSION_TOKEN=\"...\""; \
		exit 1; \
	fi
	@mkdir -p ~/.aws
	@printf '[default]\naws_access_key_id=%s\naws_secret_access_key=%s\naws_session_token=%s\n' \
		"$$AWS_ACCESS_KEY_ID" "$$AWS_SECRET_ACCESS_KEY" "$$AWS_SESSION_TOKEN" > ~/.aws/credentials
	@echo "✅ Credentials saved to ~/.aws/credentials (default profile)"

# ── Cleanup ──────────────────────────────────────────────────────────────────

## clean: remove build artifacts (dist, cdk.out, deploy hashes)
clean:
	rm -rf shared/dist backend/dist frontend/dist
	rm -rf infra/cdk/cdk.out
	rm -rf .deploy-hashes
