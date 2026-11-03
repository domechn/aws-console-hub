/** Keep a tab command's failure inside its IPC boundary. */
export async function runTabAction(action: () => void | Promise<void>, report: (err: unknown) => void): Promise<void> {
  try {
    await action()
  } catch (err) {
    report(err)
  }
}
