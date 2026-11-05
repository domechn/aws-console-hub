/** CLI spellings accepted only when constructing the child process argv. */
export const CANONICAL_TO_CLI: Record<string, string> = {
  s3: 's3api',
  codedeploy: 'deploy',
  states: 'stepfunctions',
  tag: 'resourcegroupstaggingapi',
  elasticloadbalancing: 'elbv2',
  config: 'configservice',
  'access-analyzer': 'accessanalyzer'
}

/** Noncanonical service names must never enter approval, policy, or audit records. */
export const CLI_TO_CANONICAL: Record<string, string> = {
  s3api: 's3',
  stepfunctions: 'states',
  elbv2: 'elasticloadbalancing',
  elb: 'elasticloadbalancing',
  resourcegroupstaggingapi: 'tag',
  configservice: 'config',
  accessanalyzer: 'access-analyzer',
  cloudwatchlogs: 'logs',
  costexplorer: 'ce',
  'resource-groups-tagging-api': 'tag',
  sfn: 'states',
  docdb: 'rds',
  neptune: 'rds'
}

export const serviceNameProblem = (service: string): string | null =>
  Object.hasOwn(CLI_TO_CANONICAL, service) ? `服务名称 ${service} 不受支持；请使用 ${CLI_TO_CANONICAL[service]}` : null
