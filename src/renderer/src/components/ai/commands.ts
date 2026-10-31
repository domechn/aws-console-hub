export type LocalCommand = 'new' | 'clear' | 'readonly'

const COMMANDS: Record<string, LocalCommand> = {
  '/新对话': 'new',
  '/清空': 'clear',
  '/只读': 'readonly'
}

export function localCommand(text: string): LocalCommand | null {
  return COMMANDS[text.trim()] ?? null
}

export function menuSelection(index: number, key: 'ArrowUp' | 'ArrowDown', count: number): number {
  return index < 0 ? (key === 'ArrowDown' ? 0 : count - 1) : (index + (key === 'ArrowDown' ? 1 : count - 1)) % count
}

export function canSendText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && !localCommand(trimmed)
}

/** The sole submit route: defined commands stay local; other text goes to the model. */
export function submitText(text: string, onCommand: (command: LocalCommand) => void, onSend: (text: string) => void): void {
  const trimmed = text.trim()
  const command = localCommand(trimmed)
  if (command) onCommand(command)
  else if (canSendText(trimmed)) onSend(trimmed)
}
