#!/usr/bin/env bash
# Sets a PERMANENT password for an existing Cognito user.
#
# Useful when the temporary password expired (login returns RESET_PASSWORD)
# or to skip the email reset flow. After this the user is CONFIRMED and the
# next login goes straight to TOTP MFA.
#
# Usage (default environment: prod):
#   ./scripts/set-password.sh email@example.com 'New.Secure123!'

set -euo pipefail

ENV=${ENV:-prod}
PROJECT=knowledge-inbox-zero

EMAIL=${1:?Missing EMAIL}
PASSWORD=${2:?Missing PASSWORD (min 12 chars: upper, lower, digits and symbols)}

USER_POOL_ID=$(aws ssm get-parameter --name "/${PROJECT}/${ENV}/user-pool-id" --query Parameter.Value --output text)

echo "▶ Setting permanent password for $EMAIL in pool $USER_POOL_ID"
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --password "$PASSWORD" \
  --permanent

echo "✔ Password set. The user is CONFIRMED; the next login goes straight to TOTP MFA."
