export interface NamingConfig {
  project: string;
  environment: string;
  account?: string;
  version: string;
  repository: string;
}

export class ResourceNaming {
  constructor(private config: NamingConfig) {}

  // Standard: {project}-{domain}-{env}
  standard(domain: string): string {
    return `${this.config.project}-${domain}-${this.config.environment}`;
  }

  // Global (unique per account): {project}-{domain}-{account}-{env}
  global(domain: string): string {
    return `${this.config.project}-${domain}-${this.config.account}-${this.config.environment}`;
  }

  // SSM: /{project}/{env}/{domain}
  ssm(domain: string): string {
    return `/${this.config.project}/${this.config.environment}/${domain}`;
  }

  get environment(): string {
    return this.config.environment;
  }

  // Tags applied to every resource.
  get tags(): Record<string, string> {
    return {
      iac: 'cdk',
      project: this.config.project,
      environment: this.config.environment,
      version: this.config.version,
      repository: this.config.repository,
    };
  }

  withType(type: string): Record<string, string> {
    return { ...this.tags, type };
  }
}
