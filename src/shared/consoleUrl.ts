/** An AWS console page (https, *.console.aws.amazon.com). Pure; shared so card links are checked the same way in both processes. */
export function isConsoleUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname
    return (
      u.protocol === 'https:' &&
      (host === 'console.aws.amazon.com' || host.endsWith('.console.aws.amazon.com'))
    )
  } catch {
    return false
  }
}
