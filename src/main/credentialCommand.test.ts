import { describe, expect, it } from 'vitest'
import {
  MissingCommandError,
  checkCommand,
  expandCommand,
  extractJsonObject,
  parseCredentialOutput,
  parsePathOutput,
  runCredentialCommand
} from './credentialCommand'

const target = { accountId: '111122223333', role: 'Admin', region: 'eu-west-1' }
const output = {
  Version: 1,
  AccessKeyId: 'AKIA',
  SecretAccessKey: 'secret-value',
  SessionToken: 'token',
  Expiration: '2030-01-01T00:00:00Z'
}

describe('expandCommand', () => {
  it('substitutes every placeholder', () => {
    expect(expandCommand('helper {accountId} --role {role} --region {region} {role}', target)).toBe(
      'helper 111122223333 --role Admin --region eu-west-1 Admin'
    )
  })

  it('refuses values that could escape the command line', () => {
    expect(() => expandCommand('x {role}', { ...target, role: 'a;rm -rf ~' })).toThrow('role')
    expect(() => expandCommand('x {role}', { ...target, role: '$(id)' })).toThrow('role')
    expect(() => expandCommand('x', { ...target, accountId: '1111222233334' })).toThrow('账号 ID')
    expect(() => expandCommand('x', { ...target, region: 'us-east-1`id`' })).toThrow('region')
  })

  it('keeps commands to one bounded line', () => {
    expect(() => checkCommand('a\nb')).toThrow('一行')
    expect(() => checkCommand('a'.repeat(2001))).toThrow('2000')
    expect(() => checkCommand(42)).toThrow()
  })
})

describe('parseCredentialOutput', () => {
  it('accepts credential_process JSON, with or without Version', () => {
    const { Version: _, ...noVersion } = output
    expect(parseCredentialOutput(JSON.stringify(output)).AccessKeyId).toBe('AKIA')
    expect(parseCredentialOutput(JSON.stringify(noVersion)).Expiration).toBe(output.Expiration)
  })

  it('rejects incomplete output without echoing it', () => {
    const { Expiration: _, ...noExpiry } = output
    expect(() => parseCredentialOutput(JSON.stringify(noExpiry))).toThrow('Expiration')
    expect(() => parseCredentialOutput(JSON.stringify({ ...output, Expiration: 'soon' }))).toThrow()
    expect(() => parseCredentialOutput(JSON.stringify({ ...output, Version: 2 }))).toThrow('Version')
    expect(() => parseCredentialOutput('not json secret-value')).toThrow(/^(?!.*secret-value)/)
    expect(() => parseCredentialOutput('null')).toThrow()
  })
})

describe('extractJsonObject', () => {
  it('finds the object between shell noise, braces and strings included', () => {
    const json = JSON.stringify({ ...output, SessionToken: 'a}b{"c' }, null, 2)
    const noisy = `Welcome {user}!\nzsh: no job control\n${json}\n{done} bye`
    expect(parseCredentialOutput(noisy)).toMatchObject({ AccessKeyId: 'AKIA', SessionToken: 'a}b{"c' })
  })

  it('prefers the credentials object over other JSON in the noise', () => {
    expect(extractJsonObject(`{"motd":1}\n${JSON.stringify(output)}`)).toEqual(output)
    expect(extractJsonObject('nothing here { at all')).toBeUndefined()
  })
})

describe('parsePathOutput', () => {
  it('takes the PATH between the last pair of markers', () => {
    expect(parsePathOutput('banner\n__AWS_HUB_PATH__/opt/bin:/usr/bin__AWS_HUB_PATH__\nbye')).toBe(
      '/opt/bin:/usr/bin'
    )
    expect(parsePathOutput('__AWS_HUB_PATH__echoed__AWS_HUB_PATH__ __AWS_HUB_PATH__/real__AWS_HUB_PATH__')).toBe(
      '/real'
    )
  })

  it('is undefined when the probe printed nothing usable', () => {
    expect(parsePathOutput('')).toBeUndefined()
    expect(parsePathOutput('__AWS_HUB_PATH__/half')).toBeUndefined()
    expect(parsePathOutput('__AWS_HUB_PATH____AWS_HUB_PATH__')).toBeUndefined()
  })
})

describe('runCredentialCommand', () => {
  it('hints at PATH and absolute paths when the command is missing', async () => {
    await expect(runCredentialCommand('no-such-cmd-aws-hub-test', target)).rejects.toThrow(/not found[\s\S]*绝对路径/)
  })


  it('runs through the shell with the target in the environment', async () => {
    const json = JSON.stringify({ ...output, AccessKeyId: 'ID-{accountId}', SessionToken: 'FROM_ENV' })
    const creds = await runCredentialCommand(`echo '${json}' | sed "s/FROM_ENV/$AWS_HUB_REGION/"`, target)
    expect(creds.AccessKeyId).toBe('ID-111122223333')
    expect(creds.SessionToken).toBe('eu-west-1')
  })

  it('reports stderr and a hint on failure', async () => {
    await expect(runCredentialCommand('echo login expired >&2; exit 3', target)).rejects.toThrow(
      /凭证命令执行失败[\s\S]*login expired/
    )
  })

  it('refuses to run an empty command', async () => {
    await expect(runCredentialCommand('  ', target)).rejects.toBeInstanceOf(MissingCommandError)
  })
})
