import { describe, expect, it } from 'vitest'
import { canSendText, localCommand, menuSelection, submitText } from './commands'

describe('localCommand', () => {
  it('recognizes only complete local commands and never treats prose as a command', () => {
    expect(localCommand('/新对话')).toBe('new')
    expect(localCommand(' /清空 ')).toBe('clear')
    expect(localCommand('/只读')).toBe('readonly')
    expect(localCommand('/只读 请解释')).toBeNull()
    expect(localCommand('请解释 /清空')).toBeNull()
    expect(localCommand('/')).toBeNull()
  })
})

describe('submitText', () => {
  it('does not select a slash menu item until an arrow explicitly highlights it', () => {
    expect(menuSelection(-1, 'ArrowDown', 3)).toBe(0)
    expect(menuSelection(-1, 'ArrowUp', 3)).toBe(2)
    expect(menuSelection(0, 'ArrowDown', 3)).toBe(1)
  })
  it('blocks model supplied slash replies from the send path', () => {
    expect(canSendText('/清空')).toBe(false)
    expect(canSendText(' /未知')).toBe(true)
    expect(canSendText('查看当前实例')).toBe(true)
  })
  it('keeps slash commands away from ai.send', () => {
    const sent: string[] = []
    const commands: string[] = []
    submitText('/清空', (c) => commands.push(c), (t) => sent.push(t))
    submitText('/未知', (c) => commands.push(c), (t) => sent.push(t))
    expect(commands).toEqual(['clear'])
    expect(sent).toEqual(['/未知'])
  })
})
