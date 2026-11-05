import { describe, expect, it } from 'vitest'
import { redactSecrets } from './redact'

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const TOKEN = 'IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQDexample+example/example=='

describe('redactSecrets', () => {
  it('removes a JWT in ordinary stored text', () => {
    expect(redactSecrets('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature')).toBe('token [redacted:jwt]')
  })
  it('removes access key ids, secret keys and session tokens in every shape', () => {
    const cases = [
      'my key is AKIAIOSFODNN7EXAMPLE ok',
      'temp ASIAIOSFODNN7EXAMPLE',
      `aws_secret_access_key = ${SECRET}`,
      `export AWS_SESSION_TOKEN=${TOKEN}`,
      `bare token ${TOKEN} pasted`,
      `https://s3.amazonaws.com/b/k?X-Amz-Security-Token=${encodeURIComponent(TOKEN)}&X-Amz-Date=1`,
      'deepseek key sk-0123456789abcdef0123456789abcdef',
      'bedrock ABSKQmVkcm9ja0FQSUtleS1leGFtcGxlOmV4YW1wbGVzZWNyZXQ=',
      'short-term bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbg%3D%3D&Version=1'
    ]
    for (const c of cases) {
      const out = redactSecrets(c)
      expect(out, c).toContain('[redacted')
      expect(out).not.toMatch(/AKIAIOSFODNN7EXAMPLE|ASIAIOSFODNN7EXAMPLE|EXAMPLEKEY|IQoJb3JpZ2lu|0123456789abcdef0123|QmVkcm9ja0FQSUtle|YmVkcm9jay5hbWF6b25h/)
    }
  })

  it('keeps JSON valid and the key names readable', () => {
    const json = JSON.stringify({ Credentials: { AccessKeyId: 'ASIAIOSFODNN7EXAMPLE', SecretAccessKey: SECRET, SessionToken: TOKEN } })
    expect(JSON.parse(redactSecrets(json))).toEqual({
      Credentials: { AccessKeyId: '[redacted:aws-key-id]', SecretAccessKey: '[redacted]', SessionToken: '[redacted]' }
    })
  })

  it('removes other providers keys and passwords inside JSON carried as a string, keeping the outer JSON valid', () => {
    for (const key of ['AIzaSyA-1234567890abcdefghijklmnopqrstu', 'gsk_abcdefghijklmnopqrstuvwxyz012345', 'xai-abcdefghijklmnopqrstuvwxyz012345', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'hf_abcdefghijklmnopqrstuvwxyz0123456789']) {
      expect(redactSecrets(`key ${key} here`), key).toBe('key [redacted:api-key] here')
    }
    const inner = JSON.stringify({ MasterUserPassword: 'hunter2-db', Engine: 'postgres' })
    const outer = JSON.stringify({ ResourceProperties: inner })
    const out = redactSecrets(outer)
    expect(out).not.toContain('hunter2')
    expect(JSON.parse(JSON.parse(out).ResourceProperties)).toEqual({ MasterUserPassword: '[redacted]', Engine: 'postgres' })
    expect(redactSecrets(`{"Password": "p@ss", "PasswordLastUsed": "2026"}`)).toBe(`{"Password": "[redacted]", "PasswordLastUsed": "2026"}`)
    // One level deeper (a tool result's text, stored as JSON): still caught, still valid.
    const stored = JSON.stringify({ text: outer })
    expect(redactSecrets(stored)).not.toContain('hunter2')
    expect(JSON.parse(JSON.parse(JSON.parse(redactSecrets(stored)).text).ResourceProperties).MasterUserPassword).toBe('[redacted]')
  })

  it('leaves ordinary AWS identifiers alone', () => {
    const text =
      'i-0abc1234def567890 arn:aws:iam::123456789012:role/Dev sg-0123456789abcdef0 ' +
      'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 SecretAccessKey rotation'
    expect(redactSecrets(text)).toBe(text)
  })
})
