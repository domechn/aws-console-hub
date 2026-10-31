/**
 * The AI module locks a few AWS auth variables in process.env (see lockAmbientBedrockAuth). Credential commands are
 * the user's own shell commands and must still see what the app was launched with, so the original values are
 * captured at import time, before anything is locked, and handed to those child processes.
 */
const LOCKED = ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_BEDROCK_SKIP_AUTH', 'AWS_AUTH_SCHEME_PREFERENCE'] as const

const original: Record<string, string | undefined> = {}
for (const k of LOCKED) original[k] = process.env[k]

/** Env for a user-run child process: process.env with the locked variables put back as they were at launch. */
export function userCommandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const k of LOCKED) {
    if (original[k] === undefined) delete env[k]
    else env[k] = original[k]
  }
  return env
}
