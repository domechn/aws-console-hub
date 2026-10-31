/**
 * The write table (plan §9.3): the changes with an adapter. Lookup order: name shape, this table, then reads (which
 * belong to aws_read); any other write goes to the generic adapter (generic.ts), which asks the user with the request
 * as it will be sent. Only malformed names are refused.
 */
import { classifyAction, validNames } from '../classify'
import { createChangeSet } from './cfn'
import type { ChangeAdapter } from './common'
import { updateTable } from './dynamodb'
import { EC2_ADAPTERS } from './ec2'
import { SERVICE_ADAPTERS } from './services'
import { TAGGING_ADAPTERS } from './tagging'

export const ADAPTERS: ChangeAdapter[] = [...EC2_ADAPTERS, ...SERVICE_ADAPTERS, updateTable, ...TAGGING_ADAPTERS, createChangeSet]

const BY_KEY = new Map(ADAPTERS.map((a) => [`${a.service}:${a.action}`, a]))

export type Lookup = { adapter: ChangeAdapter } | { generic: true } | { refused: 'invalid' | 'read'; reason: string }

export function lookupChange(service: unknown, action: unknown): Lookup {
  if (!validNames(service, action)) {
    return { refused: 'invalid', reason: '无效的 service 或 action 名称（service 是 IAM 前缀如 ec2，action 是 API 名如 StopInstances）' }
  }
  const adapter = BY_KEY.get(`${service as string}:${action as string}`)
  if (adapter) return { adapter }
  const c = classifyAction(service as string, action as string)
  if (c.class === 'read' || c.class === 'sensitive') return { refused: 'read', reason: `${service as string}:${action as string} 是读取操作，请用 aws_read（不在默认白名单里的读取会请用户审批）` }
  return { generic: true }
}

/** For the tool description: one line per supported change. */
export const changeCatalog = (): string => ADAPTERS.map((a) => `- ${a.service}:${a.action} — ${a.doc}`).join('\n')
