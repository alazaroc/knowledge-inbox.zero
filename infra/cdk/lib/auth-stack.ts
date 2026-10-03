import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ResourceNaming } from './naming';

interface AuthStackProps extends cdk.StackProps {
  naming: ResourceNaming;
}

export class AuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { naming } = props;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: naming.standard('users'),
      selfSignUpEnabled: true, // public sign-up (self-registration) enabled
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // MFA disabled: sign-in is CREDENTIALS -> (NEW_PASSWORD/RESET_PASSWORD) -> DONE.
      mfa: cognito.Mfa.OFF,
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true }),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: naming.standard('web-client'),
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes('role'),
      writeAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true })
        .withCustomAttributes('role'),
    });

    new ssm.StringParameter(this, 'UserPoolIdParam', {
      parameterName: naming.ssm('user-pool-id'),
      stringValue: this.userPool.userPoolId,
    });
    new ssm.StringParameter(this, 'UserPoolClientIdParam', {
      parameterName: naming.ssm('user-pool-client-id'),
      stringValue: this.userPoolClient.userPoolClientId,
    });
    new ssm.StringParameter(this, 'UserPoolArnParam', {
      parameterName: naming.ssm('user-pool-arn'),
      stringValue: this.userPool.userPoolArn,
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
