import { describe, expect, it } from 'vitest'
import { userCommandEnv } from './ambientEnv'

describe('userCommandEnv', () => {
  it('restores the launch-time value of locked AWS auth variables, not the locked one', () => {
    // At import time the test process had none of them, so a locked value must disappear again.
    const env = userCommandEnv({ PATH: '/bin', AWS_AUTH_SCHEME_PREFERENCE: 'sigv4', AWS_BEARER_TOKEN_BEDROCK: 'x' })
    expect(env.PATH).toBe('/bin')
    expect(env.AWS_AUTH_SCHEME_PREFERENCE).toBeUndefined()
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
  })
})
