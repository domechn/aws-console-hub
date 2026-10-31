/** Service and region catalog used by the Cmd+K quick-jump palette. */

export interface ServiceDef {
  id: string
  label: string
  keywords: string[]
  url: (region: string) => string
  global?: boolean
}

const c = (region: string): string => `https://${region}.console.aws.amazon.com`
const g = 'https://us-east-1.console.aws.amazon.com'

export const SERVICES: ServiceDef[] = [
  { id: 's3', label: 'S3', keywords: ['bucket', 'storage'], url: (r) => `${c(r)}/s3/buckets?region=${r}` },
  { id: 'ec2', label: 'EC2', keywords: ['instance', 'vm', 'server'], url: (r) => `${c(r)}/ec2/home?region=${r}#Instances:` },
  { id: 'lambda', label: 'Lambda', keywords: ['function', 'serverless'], url: (r) => `${c(r)}/lambda/home?region=${r}#/functions` },
  { id: 'dynamodb', label: 'DynamoDB', keywords: ['table', 'ddb', 'nosql'], url: (r) => `${c(r)}/dynamodbv2/home?region=${r}#tables` },
  { id: 'cloudwatch', label: 'CloudWatch', keywords: ['metrics', 'alarm', 'cw', 'dashboard'], url: (r) => `${c(r)}/cloudwatch/home?region=${r}` },
  { id: 'cloudwatch-logs', label: 'CloudWatch Logs', keywords: ['logs', 'log group'], url: (r) => `${c(r)}/cloudwatch/home?region=${r}#logsV2:log-groups` },
  { id: 'cloudformation', label: 'CloudFormation', keywords: ['stack', 'cfn'], url: (r) => `${c(r)}/cloudformation/home?region=${r}#/stacks` },
  { id: 'iam', label: 'IAM', keywords: ['role', 'policy', 'user', 'permission'], url: () => `${g}/iam/home#/roles`, global: true },
  { id: 'sqs', label: 'SQS', keywords: ['queue'], url: (r) => `${c(r)}/sqs/v3/home?region=${r}#/queues` },
  { id: 'sns', label: 'SNS', keywords: ['topic', 'notification'], url: (r) => `${c(r)}/sns/v3/home?region=${r}#/topics` },
  { id: 'ecs', label: 'ECS', keywords: ['container', 'fargate', 'cluster', 'task'], url: (r) => `${c(r)}/ecs/v2/clusters?region=${r}` },
  { id: 'eks', label: 'EKS', keywords: ['kubernetes', 'k8s'], url: (r) => `${c(r)}/eks/clusters?region=${r}` },
  { id: 'ecr', label: 'ECR', keywords: ['registry', 'docker', 'image', 'repository'], url: (r) => `${c(r)}/ecr/private-registry/repositories?region=${r}` },
  { id: 'rds', label: 'RDS', keywords: ['database', 'mysql', 'postgres', 'aurora'], url: (r) => `${c(r)}/rds/home?region=${r}#databases:` },
  { id: 'elasticache', label: 'ElastiCache', keywords: ['redis', 'memcached', 'cache'], url: (r) => `${c(r)}/elasticache/home?region=${r}` },
  { id: 'vpc', label: 'VPC', keywords: ['network', 'subnet', 'security group'], url: (r) => `${c(r)}/vpcconsole/home?region=${r}#vpcs:` },
  { id: 'security-groups', label: 'Security Groups', keywords: ['sg', 'firewall', 'ingress', 'egress', 'port', 'vpc'], url: (r) => `${c(r)}/vpcconsole/home?region=${r}#SecurityGroups:` },
  { id: 'route53', label: 'Route 53', keywords: ['dns', 'domain', 'hosted zone'], url: () => `${g}/route53/v2/hostedzones`, global: true },
  { id: 'cloudfront', label: 'CloudFront', keywords: ['cdn', 'distribution'], url: () => `${g}/cloudfront/v4/home#/distributions`, global: true },
  { id: 'apigateway', label: 'API Gateway', keywords: ['api', 'rest', 'http', 'apigw'], url: (r) => `${c(r)}/apigateway/main/apis?region=${r}` },
  { id: 'stepfunctions', label: 'Step Functions', keywords: ['state machine', 'workflow', 'sfn'], url: (r) => `${c(r)}/states/home?region=${r}#/statemachines` },
  { id: 'eventbridge', label: 'EventBridge', keywords: ['event', 'bus', 'rule', 'cron', 'scheduler'], url: (r) => `${c(r)}/events/home?region=${r}#/eventbuses` },
  { id: 'kms', label: 'KMS', keywords: ['key', 'encryption'], url: (r) => `${c(r)}/kms/home?region=${r}#/kms/keys` },
  { id: 'secretsmanager', label: 'Secrets Manager', keywords: ['secret', 'credential'], url: (r) => `${c(r)}/secretsmanager/listsecrets?region=${r}` },
  { id: 'cloudtrail', label: 'CloudTrail', keywords: ['audit', 'trail', 'event history'], url: (r) => `${c(r)}/cloudtrailv2/home?region=${r}` },
  { id: 'athena', label: 'Athena', keywords: ['query', 'sql'], url: (r) => `${c(r)}/athena/home?region=${r}` },
  { id: 'glue', label: 'Glue', keywords: ['etl', 'crawler', 'catalog'], url: (r) => `${c(r)}/glue/home?region=${r}` },
  { id: 'kinesis', label: 'Kinesis', keywords: ['stream'], url: (r) => `${c(r)}/kinesis/home?region=${r}#/streams/list` },
  { id: 'msk', label: 'MSK', keywords: ['kafka', 'broker', 'topic', 'streaming'], url: (r) => `${c(r)}/msk/home?region=${r}#/home/` },
  { id: 'opensearch', label: 'OpenSearch', keywords: ['elasticsearch', 'es', 'search', 'domain', 'aos'], url: (r) => `${c(r)}/aos/home?region=${r}#opensearch/domains` },
  { id: 'opensearch-serverless', label: 'OpenSearch Serverless', keywords: ['collection', 'aoss', 'vector', 'serverless search'], url: (r) => `${c(r)}/aos/home?region=${r}#opensearch/collections` },
  { id: 'ssm', label: 'Systems Manager', keywords: ['parameter store', 'ssm', 'session manager'], url: (r) => `${c(r)}/systems-manager/home?region=${r}` },
  { id: 'sagemaker', label: 'SageMaker', keywords: ['ml', 'notebook', 'training'], url: (r) => `${c(r)}/sagemaker/home?region=${r}` },
  { id: 'bedrock', label: 'Bedrock', keywords: ['llm', 'genai', 'model', 'ai'], url: (r) => `${c(r)}/bedrock/home?region=${r}` },
  { id: 'codepipeline', label: 'CodePipeline', keywords: ['pipeline', 'cicd', 'deploy'], url: (r) => `${c(r)}/codesuite/codepipeline/pipelines?region=${r}` },
  { id: 'billing', label: 'Billing', keywords: ['cost', 'bill', 'invoice'], url: () => `${g}/billing/home`, global: true }
]

export interface RegionDef {
  id: string
  label: string
  keywords: string[]
}

export const REGIONS: RegionDef[] = [
  { id: 'us-east-1', label: 'US East (N. Virginia)', keywords: ['virginia', 'iad', 'use1'] },
  { id: 'us-east-2', label: 'US East (Ohio)', keywords: ['ohio', 'cmh', 'use2'] },
  { id: 'us-west-1', label: 'US West (N. California)', keywords: ['california', 'sfo', 'usw1'] },
  { id: 'us-west-2', label: 'US West (Oregon)', keywords: ['oregon', 'pdx', 'usw2'] },
  { id: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)', keywords: ['tokyo', 'nrt', 'japan'] },
  { id: 'ap-northeast-2', label: 'Asia Pacific (Seoul)', keywords: ['seoul', 'icn', 'korea'] },
  { id: 'ap-southeast-1', label: 'Asia Pacific (Singapore)', keywords: ['singapore', 'sin'] },
  { id: 'ap-southeast-2', label: 'Asia Pacific (Sydney)', keywords: ['sydney', 'syd'] },
  { id: 'ap-south-1', label: 'Asia Pacific (Mumbai)', keywords: ['mumbai', 'bom', 'india'] },
  { id: 'eu-west-1', label: 'Europe (Ireland)', keywords: ['ireland', 'dub', 'euw1'] },
  { id: 'eu-west-2', label: 'Europe (London)', keywords: ['london', 'lhr'] },
  { id: 'eu-central-1', label: 'Europe (Frankfurt)', keywords: ['frankfurt', 'fra'] },
  { id: 'eu-north-1', label: 'Europe (Stockholm)', keywords: ['stockholm'] },
  { id: 'ca-central-1', label: 'Canada (Central)', keywords: ['canada', 'yul'] },
  { id: 'sa-east-1', label: 'South America (São Paulo)', keywords: ['sao paulo', 'gru', 'brazil'] }
]
