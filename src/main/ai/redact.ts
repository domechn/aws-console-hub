/**
 * Pattern-based scrub for AWS credentials and LLM API keys in free text (chat messages, audit params) before they are
 * stored. Replacements contain no quotes or backslashes, so redacting a JSON string keeps it valid JSON.
 * shortcut: a bare 40-char secret access key with no key name next to it is not caught (too many false positives
 * against hashes); add an entropy check if one ever turns up in stored data.
 */
const RULES: [RegExp, string][] = [
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted:aws-key-id]'],
  // `aws_secret_access_key = …`, `"SessionToken": "…"`, `X-Amz-Security-Token=…`: keep the name, drop the value.
  [
    /((?:aws_)?secret_?access_?key|(?:aws_)?session_?token|security_?token|X-Amz-Security-Token)(["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=%]{16,}/gi,
    '$1$2[redacted]'
  ],
  // Bare STS session tokens: base64 of the protobuf header they all start with.
  [/(?:IQoJb3JpZ2lu|FwoGZXIvYXdz|FQoGZXIvYXdz)[A-Za-z0-9/+=%]{40,}/g, '[redacted:aws-session-token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted:api-key]'],
  // Google (Gemini) AIza…, Groq gsk_, xAI xai-, GitHub ghp_ / github_pat_, Hugging Face hf_.
  [/\b(?:AIza[0-9A-Za-z_-]{35}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{30,})/g, '[redacted:api-key]'],
  // Password-like fields inside JSON that arrives as a string (CloudFormation ResourceProperties, templates), escaped or not.
  [/((?:\\*["'])(?:Master)?(?:User)?Password\\*["']\s*:\s*\\*["'])[^"'\\]{1,256}/gi, '$1[redacted]'],
  // Bedrock API keys: long-term `ABSK…`, short-term `bedrock-api-key-…` (a base64 presigned URL).
  [/\b(?:ABSK[A-Za-z0-9+/=]{20,}|bedrock-api-key-[A-Za-z0-9+/=%]{20,})/g, '[redacted:bedrock-api-key]']
]

export function redactSecrets(text: string): string {
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text)
}

/** Attachment-only broad scrub. It intentionally trades false positives for fewer leaked secrets. */
export function redactAttachmentSecrets(text: string): string {
  const assigned = text.replace(/(^[ \t]*["']?(?:pass(?:word)?|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?["']?[ \t]*[:=][ \t]*["']?)([^\r\n"']+)/gim,
    (_whole, key: string, value: string) => value.trim() ? `${key}[redacted]` : `${key}${value}`)
  return redactSecrets(assigned)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted:jwt]')
    .replace(/\b(?:xox[abprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[redacted:api-key]')
}
