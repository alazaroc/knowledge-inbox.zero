import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';
import { ResourceNaming } from './naming';

interface ApiStackProps extends cdk.StackProps {
  naming: ResourceNaming;
}

// Bedrock foundation model for extraction + explanation (NFR-1.2). Single
// provider, single configurable model id; env-overridable with a sensible
// default so a redeploy can switch models without a code change.
// Amazon Nova 2 Lite via the GLOBAL inference profile — the current mid-tier
// Nova: more capable than Nova Lite v1 at a similar price. The Nova family in
// eu-south-2 is only invocable through an inference profile (not on-demand); we
// use the GLOBAL profile (`global.*`) instead of the EU one (`eu.*`) so AWS can
// route the request to the least-loaded region in the whole partition, which
// reduces throttling under load. The on-demand foundation-model id
// (`amazon.nova-2-lite-v1:0`, no prefix) is NOT invocable here —
// InvokeModel returns a ValidationException — so it must stay a profile id.
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.amazon.nova-2-lite-v1:0';

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { naming } = props;

    const tableNames = {
      users: naming.standard('users'),
      profiles: naming.standard('profiles'),
      batches: naming.standard('batches'),
      documents: naming.standard('documents'),
    };

    const userPoolId = ssm.StringParameter.valueForStringParameter(
      this,
      naming.ssm('user-pool-id')
    );
    const userPoolClientId = ssm.StringParameter.valueForStringParameter(
      this,
      naming.ssm('user-pool-client-id')
    );
    const userPoolArn = ssm.StringParameter.valueForStringParameter(
      this,
      naming.ssm('user-pool-arn')
    );

    const userPool = cognito.UserPool.fromUserPoolId(this, 'UserPool', userPoolId);
    const userPoolClient = cognito.UserPoolClient.fromUserPoolClientId(
      this,
      'WebClient',
      userPoolClientId
    );

    const table = (logicalId: string, name: string) =>
      dynamodb.Table.fromTableName(this, logicalId, name);
    const tables = {
      users: table('Users', tableNames.users),
      profiles: table('Profiles', tableNames.profiles),
      batches: table('Batches', tableNames.batches),
      documents: table('Documents', tableNames.documents),
    };

    // Private content bucket (created in the storage stack). Referenced by name,
    // matching the cross-stack pattern used for the tables above.
    const contentBucket = s3.Bucket.fromBucketName(
      this,
      'ContentBucket',
      naming.standard('content')
    );

    // ── SQS: async analysis pipeline (imports enqueue, worker consumes). ──────
    // DLQ retains poison messages after maxReceiveCount redrives (Req 3.7).
    const analysisDlq = new sqs.Queue(this, 'AnalysisDlq', {
      queueName: naming.standard('analysis-dlq'),
      retentionPeriod: cdk.Duration.days(14),
    });
    // Visibility timeout ≥ 6× the 120s worker timeout (720s) per AWS guidance (Req 3.7).
    const analysisQueue = new sqs.Queue(this, 'AnalysisQueue', {
      queueName: naming.standard('analysis'),
      visibilityTimeout: cdk.Duration.seconds(720),
      deadLetterQueue: { maxReceiveCount: 3, queue: analysisDlq },
    });

    // ── Secrets Manager: ONE secret holding every user's private-repo token ──
    // A single secret whose value is a JSON map { "<userSub>": "<token>", ... }.
    // One secret (not one-per-user) keeps cost flat (~$0.40/mo total) at this
    // scale; the profile handler reads+writes the map, the worker reads it to
    // fetch a user's private profile source. Tokens are fine-grained,
    // read-only, single-repo PATs → low blast radius.
    const profileTokens = new secretsmanager.Secret(this, 'ProfileTokens', {
      secretName: naming.standard('profile-tokens'),
      description: 'JSON map of userSub → private-repo access token (fine-grained, read-only).',
      // Start as an empty JSON map (not a generated password) so the handler's
      // JSON.parse succeeds on first read.
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
    });

    const commonEnv = {
      COGNITO_USER_POOL_ID: userPoolId,
      COGNITO_CLIENT_ID: userPoolClientId,
      TABLE_USERS: tableNames.users,
      TABLE_PROFILES: tableNames.profiles,
      TABLE_BATCHES: tableNames.batches,
      TABLE_DOCUMENTS: tableNames.documents,
      ANALYSIS_QUEUE_URL: analysisQueue.queueUrl,
      PROFILE_TOKENS_SECRET: profileTokens.secretName,
    };

    // ── HTTP API (API Gateway v2): cheaper and faster than REST, with a native JWT authorizer. ──
    const authorizer = new authorizers.HttpUserPoolAuthorizer('Authorizer', userPool, {
      userPoolClients: [userPoolClient],
      identitySource: ['$request.header.Authorization'],
    });

    const httpApi = new apigwv2.HttpApi(this, 'Api', {
      apiName: naming.standard('api'),
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    (httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage).defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    };

    const fn = (name: string, handlerFile: string, extraEnv?: Record<string, string>) =>
      new NodejsFunction(this, name, {
        functionName: naming.standard(name.toLowerCase().replace(/fn$/, '')),
        entry: path.join(__dirname, '../../../backend/src/handlers', handlerFile),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        tracing: lambda.Tracing.ACTIVE,
        environment: { ...commonEnv, ...extraEnv },
        // Node 22 already ships AWS SDK v3 → don't bundle it (smaller bundle, faster cold start).
        bundling: { externalModules: ['@aws-sdk/*'], minify: true },
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
      });

    const integrationOf = new Map<lambda.IFunction, integrations.HttpLambdaIntegration>();
    const intFor = (f: lambda.IFunction) => {
      let int = integrationOf.get(f);
      if (!int) {
        int = new integrations.HttpLambdaIntegration(`Int${f.node.id}`, f, {
          payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0,
        });
        integrationOf.set(f, int);
      }
      return int;
    };
    const route = (methods: apigwv2.HttpMethod[], routePath: string, f: lambda.IFunction) =>
      httpApi.addRoutes({ path: routePath, methods, integration: intFor(f) });

    const M = apigwv2.HttpMethod;

    // Bedrock InvokeModel resources for the configured model, shared by every
    // Lambda that calls Bedrock (the analysis worker scores docs; the profile
    // handler drafts a profile from imported text). See the long note below for
    // why the GLOBAL profile needs a region wildcard.
    const isGlobalProfile = BEDROCK_MODEL_ID.startsWith('global.');
    const isEuProfile = /^eu\./.test(BEDROCK_MODEL_ID);
    const foundationModelId = BEDROCK_MODEL_ID.replace(/^(global\.|eu\.)/, '');
    let bedrockResources: string[];
    if (isGlobalProfile) {
      // GLOBAL profile routes across the ENTIRE partition and AWS can add
      // regions without notice → region wildcard `*` on both the
      // inference-profile ARN and the model-scoped foundation-model ARN. Still
      // scoped to this ONE model id and the AWS-owned namespace (empty `::`).
      bedrockResources = [
        `arn:aws:bedrock:*:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
        `arn:aws:bedrock:*::foundation-model/${foundationModelId}`,
      ];
    } else if (isEuProfile) {
      // EU profile routes across the EU partition only (eu-south-1/2,
      // eu-west-1/2/3, eu-central-1/2, eu-north-1); a hardcoded list already
      // omitted eu-south-1 → AccessDenied, so grant the `eu-*` wildcard.
      bedrockResources = [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
        `arn:aws:bedrock:eu-*::foundation-model/${foundationModelId}`,
      ];
    } else {
      // Plain on-demand model: only the single regional foundation-model ARN.
      bedrockResources = [`arn:aws:bedrock:${this.region}::foundation-model/${BEDROCK_MODEL_ID}`];
    }
    const bedrockInvokePolicy = () =>
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: bedrockResources });

    // Allow Query on the GSIs (L2 grants only cover the base table).
    const grantQueryIndexes = (f: lambda.IFunction, tableName: string) =>
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:Query'],
          resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${tableName}/index/*`],
        })
      );

    // ── Profile ──────────────────────────────────────────────────────────────
    const profileFn = fn('ProfileFn', 'profile.ts');
    tables.profiles.grantReadWriteData(profileFn);
    // Reads + writes the per-user token map (store/clear a private-repo token).
    profileTokens.grantRead(profileFn);
    profileTokens.grantWrite(profileFn);
    // Profile import (POST /profile/import) drafts a profile from fetched/pasted
    // text via one Bedrock call, so this handler also needs InvokeModel.
    profileFn.addToRolePolicy(bedrockInvokePolicy());
    route([M.GET, M.PUT], '/profile', profileFn);
    route([M.POST], '/profile/import', profileFn);

    // ── Imports (deterministic: batch creation + enqueue analysis) ────────────
    const importsFn = fn('ImportsFn', 'imports.ts');
    tables.batches.grantReadWriteData(importsFn);
    tables.documents.grantReadWriteData(importsFn);
    grantQueryIndexes(importsFn, tableNames.batches); // GSI byOwner
    analysisQueue.grantSendMessages(importsFn);
    route([M.POST, M.GET], '/imports', importsFn);
    route([M.GET], '/imports/{batchId}', importsFn);

    // ── Documents (library + detail reads; reanalyze re-queues) ──────────────
    const documentsFn = fn('DocumentsFn', 'documents.ts');
    // Reads for library/detail; writes for reanalyze (reset doc to pending,
    // adjust COUNTS, create a single-document batch, enqueue SQS).
    tables.documents.grantReadWriteData(documentsFn);
    tables.batches.grantReadWriteData(documentsFn);
    analysisQueue.grantSendMessages(documentsFn);
    grantQueryIndexes(documentsFn, tableNames.documents); // GSIs byOwner + byOwnerState
    route([M.GET], '/documents', documentsFn);
    route([M.GET, M.PATCH, M.DELETE], '/documents/{documentId}', documentsFn);
    route([M.POST], '/documents/{documentId}/reanalyze', documentsFn);

    // ── Analysis worker (SQS-triggered; the ONLY Bedrock/S3 component) ────────
    // Not built via the `fn` helper: it needs a 120s per-document budget
    // (Req 3.9), more memory, reserved concurrency, and no API route — it is
    // queue-triggered only.
    const analysisWorkerFn = new NodejsFunction(this, 'AnalysisWorkerFn', {
      functionName: naming.standard('analysis-worker'),
      entry: path.join(__dirname, '../../../backend/src/handlers', 'analysis-worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      // Node 22 already ships AWS SDK v3 → don't bundle it (same as `fn`).
      bundling: { externalModules: ['@aws-sdk/*'], minify: true },
      timeout: cdk.Duration.seconds(120), // Req 3.9 per-document budget
      memorySize: 1024,
      reservedConcurrentExecutions: 5, // bound Bedrock/host load (NFR-3)
      environment: {
        ...commonEnv,
        CONTENT_BUCKET: naming.standard('content'),
        BEDROCK_MODEL_ID,
        EMBEDDINGS_ENABLED: 'false', // Tier B embeddings deferred (OD-2)
      },
    });

    // SQS trigger: small batches (1–5) with partial-batch-failure reporting so
    // the handler's `batchItemFailures` return redrives only failed records.
    analysisWorkerFn.addEventSource(
      new eventsources.SqsEventSource(analysisQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      })
    );

    tables.documents.grantReadWriteData(analysisWorkerFn);
    tables.batches.grantReadWriteData(analysisWorkerFn);
    tables.profiles.grantReadData(analysisWorkerFn);
    contentBucket.grantReadWrite(analysisWorkerFn);
    // Worker reads the per-user token map to fetch a private profile source.
    profileTokens.grantRead(analysisWorkerFn);
    grantQueryIndexes(analysisWorkerFn, tableNames.documents); // GSIs byOwner, byOwnerState

    // Bedrock invoke for the configured model (shared policy, computed above).
    analysisWorkerFn.addToRolePolicy(bedrockInvokePolicy());

    // ── Users (managed via Cognito; ADMIN only except /users/me) ──────────────
    const usersFn = fn('UsersFn', 'users.ts');
    usersFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminGetUser',
          'cognito-idp:ListUsers',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminDeleteUser',
        ],
        resources: [userPoolArn],
      })
    );
    route([M.GET, M.POST], '/users', usersFn);
    route([M.GET], '/users/me', usersFn);
    route([M.PUT, M.DELETE], '/users/{username}', usersFn);

    new ssm.StringParameter(this, 'ApiUrlParam', {
      parameterName: naming.ssm('api-url'),
      stringValue: httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}
