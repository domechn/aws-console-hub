import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MessageAttachments, attachmentFocusTarget, lightboxOpened } from './MessageAttachments'

it('focuses the close button only when opening, preserving navigation button focus', () => {
  expect(lightboxOpened(null, 0)).toBe(true)
  expect(lightboxOpened(0, 1)).toBe(false)
  expect(lightboxOpened(1, 0)).toBe(false)
})

it('finds the current trigger after a render replaces the clicked button', () => {
  const current = { dataset: { attachmentId: 'image-1' }, disabled: false, closest: () => null }
  const root = { querySelectorAll: () => [current], closest: () => null }
  expect(attachmentFocusTarget(root as unknown as HTMLElement, 'image-1')).toBe(current)
})

it('falls back to a focusable control in the same message when the trigger disappears', () => {
  const fallback = { dataset: {}, disabled: false, closest: () => null }
  const message = { querySelectorAll: () => [fallback] }
  const root = { querySelectorAll: () => [], closest: () => message }
  expect(attachmentFocusTarget(root as unknown as HTMLElement, 'removed-image')).toBe(fallback)
})

it('chooses the trigger only after its inert background is restored', () => {
  let inert = true
  const trigger = { dataset: { attachmentId: 'image-1' }, disabled: false, closest: () => inert ? ({}) : null }
  const fallback = { dataset: {}, disabled: false, closest: () => null }
  const root = { querySelectorAll: () => [trigger], closest: () => ({ querySelectorAll: () => [fallback] }) }
  expect(attachmentFocusTarget(root as unknown as HTMLElement, 'image-1')).toBe(fallback)
  inert = false
  expect(attachmentFocusTarget(root as unknown as HTMLElement, 'image-1')).toBe(trigger)
})

it('puts image captions outside the square thumbnail and gives image load a fallback', () => {
  const html = renderToStaticMarkup(createElement(MessageAttachments, { accountId: 'a', conversationId: 'c', attachments: [{ id: 'image-1', kind: 'image', name: 'portrait.png', size: 512, thumbDataUrl: 'data:image/png;base64,AA==' }], onCopy: () => {} }))
  expect(html).toMatch(/data-attachment-id="image-1"[^]*<span class="ai-msg-image-frame">[^]*<img[^]*<\/span><span class="ai-msg-image-caption">portrait\.png<\/span>/)
})
