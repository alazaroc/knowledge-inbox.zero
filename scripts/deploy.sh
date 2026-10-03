#!/usr/bin/env bash
# End-to-end deployment for knowledge-inbox-zero.
#
# Usage (default environment: prod):
#   ./scripts/deploy.sh                  # deploy everything (infra + frontend)
#   ./scripts/deploy.sh backend          # backend only (CDK)
#   ./scripts/deploy.sh frontend         # frontend only (build + S3 sync + invalidation)
#   ENV=prod ./scripts/deploy.sh         # prod environment
#
# Incremental deploy: skips the component whose code hasn't changed since the last
# successful deploy (fingerprint in .deploy-hashes/). Force with FORCE_DEPLOY=true.
#
# Prerequisites:
#   - AWS CLI configured (profile with permissions).
#   - CDK bootstrap run in the account/region (cdk bootstrap aws://ACCOUNT/REGION).
#   - AWS_PROFILE and AWS_REGION exported, or CDK_DEFAULT_*.

set -euo pipefail

ENV=${ENV:-prod}
TARGET=${1:-all}
FORCE_DEPLOY=${FORCE_DEPLOY:-false}
PROJECT=knowledge-inbox-zero
HASH_DIR=".deploy-hashes"

# Resolve the AWS profile/region ONCE and pass them explicitly to every CDK and
# AWS CLI call below. Relying on an exported AWS_PROFILE/AWS_REGION in the caller's
# shell is fragile: when they are absent, CDK falls back to the default credential
# chain and the bootstrap-role AssumeRole fails with "ExpiredToken" even though
# `aws sts get-caller-identity --profile <p>` works. Passing --profile/--region
# makes the deploy deterministic regardless of the caller's environment.
AWS_PROFILE_ARG=""
if [ -n "${AWS_PROFILE:-}" ]; then
  AWS_PROFILE_ARG="--profile ${AWS_PROFILE}"
fi
AWS_REGION_VALUE="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-south-2}}"
# Export region so CDK (which reads CDK_DEFAULT_REGION / AWS_REGION) targets it too.
export AWS_REGION="${AWS_REGION_VALUE}"
export AWS_DEFAULT_REGION="${AWS_REGION_VALUE}"

# aws CLI wrapper that always carries the resolved profile + region.
awscli() {
  # shellcheck disable=SC2086
  aws $AWS_PROFILE_ARG --region "${AWS_REGION_VALUE}" "$@"
}

echo "→ Environment: $ENV"
echo "→ Target:      $TARGET"
echo "→ Force:       $FORCE_DEPLOY"
echo "→ Profile:     ${AWS_PROFILE:-<default chain>}"
echo "→ Region:      ${AWS_REGION_VALUE}"

mkdir -p "$HASH_DIR"

# Deterministic fingerprint of the given version-controlled paths (+ optional extra context).
# Only considers git-tracked files, so node_modules/dist/cdk.out are excluded.
fingerprint() {
  local extra="$1"
  shift
  {
    printf '%s\n' "$extra"
    git ls-files -z -- "$@" | xargs -0 shasum
  } | shasum | awk '{print $1}'
}

# Should "$1" be (re)deployed? Compares its fingerprint "$2" with the stored one (unless FORCE_DEPLOY).
changed() {
  [ "$FORCE_DEPLOY" = "true" ] && return 0
  [ "$(cat "$HASH_DIR/$1" 2>/dev/null || true)" != "$2" ]
}

# Stores the fingerprint "$2" of "$1" after a successful deploy.
mark() {
  printf '%s' "$2" >"$HASH_DIR/$1"
}

deploy_backend() {
  local fp
  fp=$(fingerprint "$ENV" infra/cdk backend shared package-lock.json)
  if ! changed "backend-$ENV" "$fp"; then
    echo "▶ Backend unchanged — skipping (set FORCE_DEPLOY=true to force)"
    return
  fi

  echo "▶ Build shared"
  npm run build -w shared

  # CDK synth takes ~35-45s (TS compile + Lambda bundling). The AWS profile's
  # credential_process can vend tokens with a lifetime shorter than that, so a
  # single `cdk deploy` (synth THEN assume-role) hits "ExpiredToken" when the
  # assume fires after the long synth. Fix: synth to cdk.out FIRST (no AWS calls,
  # nothing to expire), then warm the credential cache and deploy the PREBUILT
  # assembly — that deploy's assume-role runs within milliseconds, inside the
  # token's lifetime.
  echo "▶ CDK synth (prebuild assembly, no AWS calls)"
  # shellcheck disable=SC2086
  (cd infra/cdk && npx cdk synth --all -q -c env="$ENV" $AWS_PROFILE_ARG)

  echo "▶ Deploy prebuilt assembly"
  # The CDK Node SDK does not refresh near-expiry SSO credentials the way the
  # Python CLI does, so a `cdk deploy` relying on the profile fails its
  # bootstrap-role assume with "ExpiredToken" even when `aws` works. Fix:
  # materialize fresh session credentials from the profile with the CLI
  # (`export-credentials`) and hand them to CDK as process env for this one
  # command. These are vended by the CLI from the live SSO session — the script
  # never reads a credentials file. Fall back to plain --profile if the CLI is
  # too old to support export-credentials.
  if cred_env=$(awscli configure export-credentials --format env-no-export 2>/dev/null) && [ -n "$cred_env" ]; then
    (cd infra/cdk && env $cred_env AWS_REGION="$AWS_REGION_VALUE" \
      npx cdk deploy --all --app cdk.out --require-approval never -c env="$ENV" --concurrency 4)
  else
    # shellcheck disable=SC2086
    (cd infra/cdk && npx cdk deploy --all --app cdk.out --require-approval never -c env="$ENV" --concurrency 4 $AWS_PROFILE_ARG)
  fi

  mark "backend-$ENV" "$fp"
}

deploy_frontend() {
  echo "▶ Resolving endpoints from SSM"
  local USER_POOL_ID USER_POOL_CLIENT_ID API_URL BUCKET DIST_ID fp

  USER_POOL_ID=$(awscli ssm get-parameter --name "/${PROJECT}/${ENV}/user-pool-id" --query Parameter.Value --output text)
  USER_POOL_CLIENT_ID=$(awscli ssm get-parameter --name "/${PROJECT}/${ENV}/user-pool-client-id" --query Parameter.Value --output text)
  API_URL=$(awscli ssm get-parameter --name "/${PROJECT}/${ENV}/api-url" --query Parameter.Value --output text)
  BUCKET=$(awscli cloudformation describe-stacks --stack-name "${PROJECT}-frontend-${ENV}" \
    --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" --output text)
  DIST_ID=$(awscli cloudformation describe-stacks --stack-name "${PROJECT}-frontend-${ENV}" \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)

  # Endpoints are baked into the build → if they change (e.g. a new API URL), redeploy.
  fp=$(fingerprint "${API_URL}|${USER_POOL_ID}|${USER_POOL_CLIENT_ID}" frontend shared package-lock.json)
  if ! changed "frontend-$ENV" "$fp"; then
    echo "▶ Frontend unchanged — skipping (set FORCE_DEPLOY=true to force)"
    return
  fi

  echo "▶ Build frontend with env vars"
  VITE_USER_POOL_ID="$USER_POOL_ID" \
    VITE_USER_POOL_CLIENT_ID="$USER_POOL_CLIENT_ID" \
    VITE_API_URL="$API_URL" \
    npm run build -w frontend

  echo "▶ Sync to s3://$BUCKET"
  awscli s3 sync frontend/dist "s3://$BUCKET" --delete

  echo "▶ Invalidating CloudFront $DIST_ID"
  local INV_FILE
  INV_FILE=$(mktemp -t cf-invalidation.XXXXXX.json)
  printf '{"Paths":{"Quantity":1,"Items":["/*"]},"CallerReference":"deploy-%s"}' "$(date +%s)" >"$INV_FILE"
  awscli cloudfront create-invalidation --distribution-id "$DIST_ID" --invalidation-batch "file://$INV_FILE" >/dev/null
  rm -f "$INV_FILE"

  mark "frontend-$ENV" "$fp"
}

case "$TARGET" in
  all)
    deploy_backend
    deploy_frontend
    ;;
  backend)
    deploy_backend
    ;;
  frontend)
    deploy_frontend
    ;;
  *)
    echo "Unrecognized target: $TARGET (use: all | backend | frontend)"
    exit 1
    ;;
esac

echo "✔ Deployment complete."
