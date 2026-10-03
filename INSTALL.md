# Installing & running Knowledge Inbox Zero

There are two ways to use this app. Pick the one that fits you.

|           | **Use the hosted web app**              | **Self-host (your own AWS account)**           |
| --------- | --------------------------------------- | ---------------------------------------------- |
| Effort    | Zero — just sign in                     | ~20 min first time                             |
| Cost      | Free (owner-funded, with a daily limit) | You pay your own AWS bill                      |
| Your data | Lives in the owner's account            | Lives in **your** account, nobody else sees it |
| Limits    | 50 links/day per user (USER role)       | Whatever you set — ADMIN is unlimited          |
| Best for  | Trying it, light use                    | Heavy use, full control, privacy               |

---

## Option A — Use the hosted web app

Nothing to install. Open the app and sign in:

**https://inbox.playingaws.com**

- Sign up with email + password (you'll confirm your email once).
- Set your knowledge profile under **Settings** so scoring reflects what you care about.
- Paste links under **Add content** and read your **Library**, most valuable first.
- Regular accounts can analyze **50 new links per day** (a cost-control limit). When you hit it the app shows you the links it didn't process so you can save them and retry tomorrow. Need more? Ask the owner for extended access.

**Install it on your phone (PWA):** open the site in your mobile browser, then
"Add to Home Screen" (iOS Safari: Share → Add to Home Screen; Android Chrome:
menu → Install app / Add to Home screen). It launches full-screen like a native app.

---

## Option B — Self-host on your own AWS account

The app does **not** reference any specific AWS account — it deploys against whatever
credentials and account **you** configure. Nothing you deploy touches anyone else's account.

### What you need

- **Node.js ≥ 22** and **npm**.
- An **AWS account**, with the **AWS CLI** configured (`aws configure` or `aws sso login`).
- **AWS CDK** bootstrapped in your account/region (`cdk bootstrap`, once).
- **Amazon Bedrock model access enabled** for the model you'll use. In some regions
  (e.g. `eu-south-2` / Spain) Nova/Claude require an **inference profile** — see
  "Choosing a region & model" below.

### 1. Clone and install

```bash
git clone https://github.com/alazaroc/knowledge-inbox-zero.git
cd knowledge-inbox-zero
make install        # npm ci — clean, reproducible
make build          # build shared + backend + frontend
```

### 2. Point it at YOUR account

The deploy scripts and CDK use your ambient AWS credentials. Set the profile and
region you want to deploy into:

```bash
export AWS_PROFILE=your-profile      # the account you want to deploy into
export AWS_REGION=eu-west-1          # the region you want (default is eu-south-2)
```

Bootstrap CDK once per account/region:

```bash
cdk bootstrap aws://<your-account-id>/<your-region>
```

### 3. Deploy

```bash
AWS_PROFILE=your-profile AWS_REGION=your-region ENV=prod make deploy
```

This creates, **in your account**: DynamoDB tables, a Cognito user pool (with TOTP MFA),
an HTTP API + Lambdas + SQS, and a private S3 bucket behind CloudFront. The command
prints your CloudFront URL at the end.

### 4. Create your first (admin) user

```bash
AWS_PROFILE=your-profile AWS_REGION=your-region \
  make create-admin EMAIL=you@example.com PASSWORD='Temp.123!' ENV=prod
```

On first login Cognito forces a password change + TOTP MFA setup. User creation is
invite-only (there is no open self-signup on a self-hosted instance unless you add it).

### 5. Run the frontend locally (optional, for development)

```bash
make dev-env     # fills frontend/.env from your deployed SSM params (run once after deploy)
make dev         # Vite dev server pointed at your deployed backend
```

---

## Choosing a region & model

- **Region** defaults to `eu-south-2`. Override with `AWS_REGION` (deploy) — nothing is
  hardcoded to a specific region in the app logic.
- **Model** is set at deploy time via `BEDROCK_MODEL_ID` (a redeploy switches models with
  no code change). Pick a model your account has Bedrock access to.
- **Inference profiles**: in regions like `eu-south-2`, on-demand invocation of Nova/Claude
  requires an EU **inference profile** (`eu.amazon.*` / `eu.anthropic.*`) rather than the
  bare model id. Check with `aws bedrock list-inference-profiles`. An EU inference profile
  routes to any of its member regions, so the Lambda's IAM must allow the model ARN across
  all of them — the CDK already scopes this to the model with a region wildcard.

## Optional: a custom domain

A custom domain is **opt-in** — you don't inherit anyone else's. To serve the app on your
own domain:

1. Request an **ACM certificate in `us-east-1`** (CloudFront requires us-east-1) for your
   domain, DNS-validated.
2. Deploy the frontend stack passing the domain + cert via CDK context:

   ```bash
   cd infra/cdk
   npx cdk deploy <project>-frontend-prod \
     -c env=prod \
     -c domainName=inbox.yourdomain.com \
     -c certificateArn=arn:aws:acm:us-east-1:<your-account>:certificate/<id> \
     --require-approval never
   ```

3. Add an **A/AAAA alias** record for your domain pointing at the CloudFront distribution.

## Making it yours (branding)

- The footer "About" links point to the original author's blog/profile
  (`frontend/src/components/Footer.tsx`) — change these to your own.
- `knowledge-inbox-zero` (project slug) and `eu-south-2` (region) are the repo-wide
  placeholders; the internal `@app/*` package names are fixed and not renamed.

## Tearing it down

```bash
cd infra/cdk
npx cdk destroy --all -c env=prod      # removes the stacks from YOUR account
```

The content S3 bucket is retained on purpose (so you don't lose extracted content by
accident); delete it manually if you want it gone.

---

See [README.md](README.md) for the architecture, the Marginal Knowledge Value model, and
the full command reference.
