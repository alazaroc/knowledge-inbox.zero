#!/usr/bin/env bash
# Creates a user in the Cognito User Pool and tags it with a role.
#
# Usage (default environment: prod):
#   ./scripts/create-user.sh email@example.com 'PasswordTemp.123' USER
#   ./scripts/create-user.sh email@example.com 'PasswordTemp.123' ADMIN

set -euo pipefail

ENV=${ENV:-prod}
PROJECT=knowledge-inbox-zero

EMAIL=${1:?Missing EMAIL}
PASSWORD=${2:?Missing temporary PASSWORD}
ROLE=${3:-USER}

USER_POOL_ID=$(aws ssm get-parameter --name "/${PROJECT}/${ENV}/user-pool-id" --query Parameter.Value --output text)

echo "▶ Creating user $EMAIL (role=$ROLE) in pool $USER_POOL_ID"
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true "Name=custom:role,Value=$ROLE" \
  --message-action SUPPRESS \
  --temporary-password "$PASSWORD" >/dev/null

echo "✔ User created. On first login they will be asked to change the password and set up TOTP MFA."
