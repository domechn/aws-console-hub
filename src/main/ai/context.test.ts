import { describe, expect, it } from 'vitest'
import { compactContext, estimateTokens, mergeUserTurns } from './context'

const sys = { role: 'system', content: 'prompt' }
const user = (t: string) => ({ role: 'user', content: t })
const call = { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'x' }] }
const result = (text: string) => ({ role: 'toolResult', toolName: 'list_ec2_instances', content: [{ type: 'text', text }] })
const answer = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
const turn = (i: number, size = 10) => [user(`q${i}`), call, result('r'.repeat(size)), answer]

const resultTexts = (ms: { role: string; content?: unknown }[]): string[] =>
  ms.filter((m) => m.role === 'toolResult').map((m) => (m.content as { text: string }[])[0].text)

describe('compactContext', () => {
  it('leaves a small conversation alone', () => {
    const ms = [sys, ...turn(1), ...turn(2)]
    expect(compactContext(ms, 100_000)).toEqual(ms)
  })

  it('elides tool results older than the kept turns', () => {
    const ms = [sys, ...turn(1), ...turn(2), ...turn(3)]
    const out = compactContext(ms, 100_000, 2)
    expect(resultTexts(out)[0]).toMatch(/^\[已省略：较早的 list_ec2_instances 结果/)
    expect(resultTexts(out).slice(1)).toEqual(['r'.repeat(10), 'r'.repeat(10)])
    expect(out).toHaveLength(ms.length)
  })

  it('over budget: elides old results first, then drops the oldest turns, never the system prompt or latest turn', () => {
    const ms = [sys, ...turn(1, 3000), ...turn(2, 3000), ...turn(3, 3000)]
    const elided = compactContext(ms, 1800)
    expect(elided).toHaveLength(ms.length)
    expect(resultTexts(elided).map((t) => t.startsWith('[已省略'))).toEqual([true, true, false])

    const dropped = compactContext(ms, 900)
    expect(dropped[0]).toBe(sys)
    expect(dropped.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    expect(dropped[1]).toEqual(user('q3'))
    // The latest turn's own result is kept even when that alone is over budget.
    expect(resultTexts(dropped)).toEqual(['r'.repeat(3000)])
  })

  it('estimates tokens from size', () => {
    expect(estimateTokens([user('x'.repeat(3000))])).toBeGreaterThan(1000)
    expect(estimateTokens([{ role: 'user', content: [{ type: 'image', data: 'a'.repeat(100_000), mimeType: 'image/jpeg' }] }])).toBeGreaterThanOrEqual(1600)
  })
})

describe('mergeUserTurns', () => {
  it('joins back-to-back user messages and leaves everything else alone', () => {
    const stored = { role: 'user', content: [{ type: 'text', text: '[proposal_result] {}' }] }
    expect(mergeUserTurns([sys, answer, stored, user('next')])).toEqual([
      sys,
      answer,
      { role: 'user', content: [{ type: 'text', text: '[proposal_result] {}' }, { type: 'text', text: '\n\n' }, { type: 'text', text: 'next' }] }
    ])
    const ms = turn(1)
    expect(mergeUserTurns(ms)).toEqual(ms)
  })
})
