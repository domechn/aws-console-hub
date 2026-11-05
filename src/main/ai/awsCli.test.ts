import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AwsClients, SDK } from './aws'
import { cliCall, cliOperation, NON_API_CLI_COMMANDS, nonApiCliReason, validateAwsCliPath } from './awsCli'
import { CLI_TO_CANONICAL } from './serviceNames'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fake(body: string): { dir: string; cli: string; record: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hub-cli-test-'))
  dirs.push(dir)
  const cli = join(dir, 'aws')
  const record = join(dir, 'record.json')
  writeFileSync(cli, `#!/usr/bin/env node\n${body}`)
  chmodSync(cli, 0o700)
  return { dir, cli, record }
}

const creds = { AccessKeyId: 'FAKEACCESS', SecretAccessKey: 'FAKESECRET', SessionToken: 'FAKETOKEN', Expiration: '2999-01-01' }

describe('AWS CLI fallback', () => {
  it('rejects normalized Windows UNC spellings', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      for (const value of ['//server/share/aws.exe', '\\\\/server/share/aws.exe', '/\\\\server\\\\share\\\\aws.exe']) {
        expect(() => validateAwsCliPath(value), value).toThrow('UNC')
      }
    } finally { platform.mockRestore() }
  })
  it('permits the KMS Sign API but refuses CloudFront sign customization', () => {
    expect(NON_API_CLI_COMMANDS['*']).not.toContain('sign')
    expect(NON_API_CLI_COMMANDS.cloudfront).toContain('sign')
  })
  it.each([
    ['lightsail', 'PushContainerImage'], ['ecr', 'GetLogin'], ['ecr', 'GetLoginPassword'],
    ['s3', 'Presign'], ['eks', 'UpdateKubeconfig'], ['eks', 'GetToken'],
    ['cloudformation', 'Package'], ['cloudformation', 'Deploy'], ['ecs', 'ExecuteCommand'],
    ['ssm', 'StartSession'], ['emr', 'Ssh'], ['emr-containers', 'UpdateRoleTrustPolicy'],
    ['codeartifact', 'Login'], ['deploy', 'Push']
  ])('keeps local CLI customization %s:%s blocked', (service, action) => {
    expect(nonApiCliReason(service, action)).toContain('不是 API 调用')
  })
  it.each([
    ['CreateCluster', 'RunJobFlow'], ['AddSteps', 'AddJobFlowSteps'],
    ['InstallApplications', 'AddJobFlowSteps'], ['CreateHbaseBackup', 'AddJobFlowSteps'],
    ['RestoreFromHbaseBackup', 'AddJobFlowSteps'], ['ScheduleHbaseBackup', 'AddJobFlowSteps'],
    ['DisableHbaseBackups', 'AddJobFlowSteps'], ['TerminateClusters', 'TerminateJobFlows']
  ])('refuses EMR wrapper %s and points to %s', (action, api) => {
    expect(nonApiCliReason('emr', action)).toContain(`请使用 API 操作名：${api}`)
    expect(nonApiCliReason('emr', api)).toBeNull()
  })
  it.each(['Install', 'Uninstall', 'Push', 'Register', 'Deregister'])('refuses CodeDeploy local command %s under both names', (action) => {
    expect(nonApiCliReason('codedeploy', action)).toContain('不是 API 调用')
    expect(nonApiCliReason('deploy', action)).toContain('不是 API 调用')
  })
  it('refuses the ECS monitor express gateway service wrapper', () => {
    expect(nonApiCliReason('ecs', 'MonitorExpressGatewayService')).toContain('不是 API 调用')
  })
  it('masks secret request values echoed in CLI stderr', async () => {
    const value = 'secret-user-data-123'
    const f = fake(`console.error("type error: ${value} is invalid"); process.exit(2)`)
    await expect(cliCall(f.cli, creds, 'ec2', 'RunInstances', { UserData: value }, 'us-east-1', 1000)).rejects.not.toThrow(value)
  })
  it('waits for a stopped CLI to close before wiping its input file', async () => {
    const f = fake(`process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),120));require('fs').writeFileSync(${JSON.stringify('READY_PATH')},process.cwd());setInterval(()=>{},1000)`)
    writeFileSync(f.cli, readFileSync(f.cli, 'utf8').replace('READY_PATH', join(f.dir, 'ready')))
    const controller = new AbortController()
    const pending = cliCall(f.cli, creds, 'budgets', 'ListBudgets', { Secret: 'FAKESECRET' }, 'us-east-1', 2000, controller.signal)
    await vi.waitFor(() => expect(existsSync(join(f.dir, 'ready'))).toBe(true))
    const cwd = readFileSync(join(f.dir, 'ready'), 'utf8')
    controller.abort()
    await expect(pending).rejects.toThrow('已停止')
    expect(existsSync(join(cwd, 'input.json'))).toBe(false)
  })
  it('does not send a delayed kill after the CLI exits', async () => {
    const f = fake(`console.log('{"ok":true}')`)
    const kill = process.kill.bind(process)
    const calls: [number, string | number | undefined][] = []
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      calls.push([pid, signal])
      return kill(pid, signal)
    })
    try {
      expect(await cliCall(f.cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 1000)).toEqual({ ok: true })
      const onExit = calls.filter(([, signal]) => signal === 'SIGKILL').length
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(onExit)
    } finally { spy.mockRestore() }
  })
  it('settles after CLI exit when a detached grandchild keeps stdout open', async () => {
    const f = fake(`const fs=require('fs'); const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,1]}); child.unref(); fs.writeFileSync(${JSON.stringify('PID_PATH')},String(child.pid)); console.log('{"ok":true}')`)
    const scratch = mkdtempSync(join(tmpdir(), 'hub-cli-scratch-'))
    dirs.push(scratch)
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = scratch
    writeFileSync(f.cli, readFileSync(f.cli, 'utf8').replace('PID_PATH', join(f.dir, 'grandchild')))
    try {
      const result = await Promise.race([
        cliCall(f.cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 2000),
        new Promise((_, reject) => setTimeout(() => reject(new Error('hung after exit')), 1200))
      ])
      expect(result).toEqual({ ok: true })
      expect(readdirSync(scratch)).toEqual([])
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      if (existsSync(join(f.dir, 'grandchild'))) {
        try { process.kill(Number(readFileSync(join(f.dir, 'grandchild'), 'utf8')), 'SIGKILL') } catch { /* exited */ }
      }
    }
  })
  it('refuses aliases before loading credentials or spawning', async () => {
    let loaded = 0
    const clients = new AwsClients(async () => { loaded++; return creds }, () => '/missing/aws')
    for (const [alias, canonical] of Object.entries(CLI_TO_CANONICAL)) {
      expect(await clients.supports(alias, 'ListThings')).toContain(`请使用 ${canonical}`)
      await expect(clients.callCli('a', alias, 'ListThings', {}, 'us-east-1')).rejects.toThrow(`请使用 ${canonical}`)
      await expect(cliCall('/missing/aws', creds, alias, 'ListThings', {}, 'us-east-1', 100)).rejects.toThrow(`请使用 ${canonical}`)
    }
    expect(loaded).toBe(0)
  })
  it('refuses RDS compatible service aliases without sweeping in separate APIs', async () => {
    const clients = new AwsClients(async () => { throw new Error('no credentials') })
    await expect(clients.call('a', 'docdb', 'ModifyDBClusterSnapshotAttribute', { AttributesToAdd: ['all'] }, 'us-east-1')).rejects.toThrow('请使用 rds')
    await expect(clients.call('a', 'neptune', 'ModifyDBClusterSnapshotAttribute', { AttributesToAdd: ['all'] }, 'us-east-1')).rejects.toThrow('请使用 rds')
    for (const service of ['docdb-elastic', 'neptunedata', 'neptune-graph']) {
      expect(await clients.supports(service, 'ListThings')).toBeNull()
    }
  })
  it('refuses every non-API CLI command before loading credentials or spawning', async () => {
    let credentials = 0
    const clients = new AwsClients(async () => { credentials++; return creds }, () => '/missing/aws')
    for (const [service, actions] of Object.entries(NON_API_CLI_COMMANDS)) {
      if (service === '*') continue
      for (const action of actions) {
        const api = action === '*' ? 'ListAnything' : action.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')
        await expect(clients.supports(service, api)).resolves.toContain('不是 API 调用')
        await expect(clients.callCli('a', service, api, {}, 'us-east-1')).rejects.toThrow('不是 API 调用')
      }
    }
    for (const action of NON_API_CLI_COMMANDS['*']) {
      const api = action === 'generate-*-token' ? 'GenerateFutureToken' : action.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')
      await expect(clients.supports('budgets', api)).resolves.toContain('不是 API 调用')
    }
    expect(credentials).toBe(0)
    for (const [service, action] of [['emr', 'RunJobFlow'], ['ssm', 'SendCommand'], ['cloudformation', 'CreateStack']]) {
      expect(await clients.supports(service, action)).toBeNull()
    }
  })

  it('maps s3 API operations to s3api', async () => {
    const f = fake(`console.log(JSON.stringify({service:process.argv[2]}))`)
    expect(await cliCall(f.cli, creds, 's3', 'ListFutureThings', {}, 'us-east-1', 1000)).toEqual({ service: 's3api' })
  })
  it('maps CodeDeploy API operations to the deploy CLI service', async () => {
    const f = fake(`console.log(JSON.stringify({service:process.argv[2],action:process.argv[3]}))`)
    expect(await cliCall(f.cli, creds, 'codedeploy', 'CreateDeployment', {}, 'us-east-1', 1000)).toEqual({
      service: 'deploy', action: 'create-deployment'
    })
  })
  it.each([
    ['DescribeDBInstances', 'describe-db-instances'],
    ['GetCostAndUsage', 'get-cost-and-usage'],
    ['ListAPIKeys', 'list-api-keys'],
    ['CreateBudget', 'create-budget']
  ])('%s becomes %s', (name, want) => expect(cliOperation(name)).toBe(want))

  it('uses a private input file, isolated credentials, and exact argv', async () => {
    const f = fake(`const fs=require('fs'); const args=process.argv.slice(2); const input=args[args.indexOf('--cli-input-json')+1].slice(7); fs.writeFileSync(${JSON.stringify(fixRecord())}, JSON.stringify({args, env:process.env, cwd:process.cwd(), input:JSON.parse(fs.readFileSync(input,'utf8')), mode:fs.statSync(input).mode & 0o777, path:input})); console.log('{"ok":true}')`)
    // The record destination is passed through a test-only environment variable, never through CLI argv.
    const script = readFileSync(f.cli, 'utf8').replace(JSON.stringify(fixRecord()), JSON.stringify(f.record))
    writeFileSync(f.cli, script)
    const clients = new AwsClients(async () => creds, () => f.cli)
    const oldProfile = process.env.AWS_PROFILE
    process.env.AWS_PROFILE = 'must-not-inherit'
    try {
    expect(await clients.supports('budgets', 'CreateBudget')).toBeNull()
    expect(await clients.call('a', 'budgets', 'CreateBudget', { AccountId: '123', Budget: { BudgetName: 'x' } }, 'us-east-1')).toEqual({ ok: true })
    } finally {
      if (oldProfile === undefined) delete process.env.AWS_PROFILE
      else process.env.AWS_PROFILE = oldProfile
    }
    const r = JSON.parse(readFileSync(f.record, 'utf8'))
    expect(r.args.slice(0, 2)).toEqual(['budgets', 'create-budget'])
    expect(r.args.slice(2)).toEqual(['--cli-input-json', `file://${r.path}`, '--region', 'us-east-1', '--output', 'json', '--no-cli-pager', '--no-paginate'])
    expect(r.input).toEqual({ AccountId: '123', Budget: { BudgetName: 'x' } })
    expect(r.mode).toBe(0o600)
    expect(readdirSync(f.dir)).not.toContain(r.path.split('/').at(-1))
    expect(JSON.stringify(r.args)).not.toContain('FAKESECRET')
    expect(r.env.AWS_SECRET_ACCESS_KEY).toBe('FAKESECRET')
    expect(r.env.AWS_PROFILE).toBeUndefined()
    expect(r.env.AWS_CONFIG_FILE).toBe('/dev/null')
    expect(r.env.AWS_SHARED_CREDENTIALS_FILE).toBe('/dev/null')
    expect(r.env.AWS_EC2_METADATA_DISABLED).toBe('true')
    expect(r.env.HOME).toBe(join(r.path, '..'))
    expect(r.cwd).toBe(r.env.HOME)
    expect(r.env.USERPROFILE).toBe(r.env.HOME)
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) expect(r.env[name]).toBe(r.env.HOME)
  })

  it('ignores ambient AWS endpoints and auth selectors, with test endpoints only by injection', async () => {
    const f = fake(`console.log(JSON.stringify({endpoint:process.env.AWS_ENDPOINT_URL, nested:process.env.AWS_ENDPOINT_URL_S3, profile:process.env.AWS_PROFILE, role:process.env.AWS_ROLE_ARN, container:process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, web:process.env.AWS_WEB_IDENTITY_TOKEN_FILE, proxy:process.env.HTTP_PROXY, ca:process.env.AWS_CA_BUNDLE}))`)
    const names = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_PROFILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'HTTP_PROXY', 'AWS_CA_BUNDLE']
    const old = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    try {
      for (const name of names) process.env[name] = 'must-not-inherit'
      expect(await cliCall(f.cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 1000)).toEqual({ proxy: 'must-not-inherit', ca: 'must-not-inherit' })
      expect(await cliCall(f.cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 1000, undefined, 'http://127.0.0.1:1')).toEqual({ endpoint: 'http://127.0.0.1:1', proxy: 'must-not-inherit', ca: 'must-not-inherit' })
    } finally {
      for (const name of names) if (old[name] === undefined) delete process.env[name]
      else process.env[name] = old[name]
    }
  })

  it('parses JSON before redacting values', async () => {
    const f = fake(`console.log(JSON.stringify({value:'FAKESECRET', nested:['FAKETOKEN']}))`)
    expect(await cliCall(f.cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 1000)).toEqual({ value: '[redacted]', nested: ['[redacted]'] })
  })

  it('rejects malformed names and reports a missing CLI', async () => {
    const clients = new AwsClients(async () => creds, () => '/missing/aws')
    expect(await clients.supports('Bad Service', 'CreateBudget')).toContain('无效')
    expect(await clients.supports('--no-sign-request', 'ListThings')).toContain('无效')
    await expect(cliCall('/missing/aws', creds, 'cloudtrail', 'stopLogging', {}, 'us-east-1', 1000)).rejects.toThrow('PascalCase')
    await expect(clients.call('a', 'budgets', 'CreateBudget', {}, 'us-east-1')).rejects.toThrow('AWS CLI 路径')
  })

  it('revalidates a configured CLI executable at use time', async () => {
    const f = fake(`console.log('{"ok":true}')`)
    const clients = new AwsClients(async () => creds, () => f.cli)
    expect(await clients.callCli('a', 'budgets', 'ListBudgets', {}, 'us-east-1')).toEqual({ ok: true })
    chmodSync(f.cli, 0o600)
    await expect(clients.callCli('a', 'budgets', 'ListBudgets', {}, 'us-east-1')).rejects.toThrow('不可执行')
  })

  it('refuses a member the SDK serializer would silently drop', async () => {
    const f = fake(`console.log('{"validated":true}')`)
    const original = SDK.sqs
    SDK.sqs = { client: 'FakeClient', load: async () => ({ ListQueuesCommand: class {}, ListQueuesRequest$: [0, '', 0, 0, ['QueueNamePrefix']], FakeClient: class { send(): never { throw new Error('SDK call would drop UnknownMember') } } }) }
    try {
      const clients = new AwsClients(async () => creds, () => f.cli)
      await expect(clients.call('a', 'sqs', 'ListQueues', { UnknownMember: 'must-not-drop' }, 'us-east-1')).rejects.toThrow('未知参数 UnknownMember；可用：QueueNamePrefix')
    } finally {
      SDK.sqs = original
    }
  })

  it('maps invalid CLI choices and redacts credential text in errors', async () => {
    const f = fake(`console.error("usage: aws\\ninvalid choice: create-budget; FAKESECRET"); process.exit(2)`)
    await expect(cliCall(f.cli, creds, 'budgets', 'CreateBudget', {}, 'us-east-1', 1000)).rejects.toThrow(/AWS CLI 没有这个命令：budgets create-budget/)
    await expect(cliCall(f.cli, creds, 'budgets', 'CreateBudget', {}, 'us-east-1', 1000)).rejects.not.toThrow('FAKESECRET')
  })

  it('maps SDK service aliases to CLI service names', async () => {
    const f = fake(`console.log(JSON.stringify({service:process.argv[2]}))`)
    const clients = new AwsClients(async () => creds, () => f.cli)
    expect(await clients.call('a', 'states', 'ListFutureThings', {}, 'us-east-1')).toEqual({ service: 'stepfunctions' })
    expect(await clients.call('a', 'tag', 'ListFutureThings', {}, 'us-east-1')).toEqual({ service: 'resourcegroupstaggingapi' })
    expect(await clients.call('a', 'elasticloadbalancing', 'ListFutureThings', {}, 'us-east-1')).toEqual({ service: 'elbv2' })
    expect(await clients.call('a', 'config', 'ListFutureThings', {}, 'us-east-1')).toEqual({ service: 'configservice' })
    expect(await clients.call('a', 'access-analyzer', 'ListFutureThings', {}, 'us-east-1')).toEqual({ service: 'accessanalyzer' })
  })

  it('caps large output and terminates an aborted call', async () => {
    const big = fake(`console.log(JSON.stringify({data:'x'.repeat(2_000_000)}))`)
    expect(await cliCall(big.cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 1000)).toMatchObject({ truncated: true })
    const slow = fake(`setInterval(() => {}, 1000)`)
    const controller = new AbortController()
    const pending = cliCall(slow.cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 1000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('已停止')
    await expect(cliCall(slow.cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 30)).rejects.toThrow('超时')
  })

  it('kills CLI descendants when the user aborts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-cli-tree-'))
    dirs.push(dir)
    const ready = join(dir, 'ready')
    const marker = join(dir, 'marker')
    const cli = join(dir, 'aws')
    writeFileSync(cli, `#!/usr/bin/env node\nsetTimeout(()=>{require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),250)`)}],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},'yes')},60);setInterval(()=>{},1000)`)
    chmodSync(cli, 0o700)
    const controller = new AbortController()
    const pending = cliCall(cli, creds, 'budgets', 'ListBudgets', {}, 'us-east-1', 2000, controller.signal)
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true))
    controller.abort()
    await expect(pending).rejects.toThrow('已停止')
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(existsSync(marker)).toBe(false)
  })
})

function fixRecord(): string { return 'RECORD_PATH' }
