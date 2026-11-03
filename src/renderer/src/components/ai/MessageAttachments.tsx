import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AttachmentMeta } from '../../../../shared/ai'
import { formatSize, safeImageSrc } from './attachments'

export function lightboxOpened(before: number | null, after: number | null): boolean { return before === null && after !== null }

export function attachmentFocusTarget(root: HTMLElement | null, id: string | null): HTMLElement | null {
  const available = (element: HTMLElement): boolean => !(element as HTMLButtonElement).disabled && !element.closest('[inert], [aria-hidden="true"]')
  const current = id ? [...root?.querySelectorAll<HTMLButtonElement>('button[data-attachment-id]') ?? []].find((button) => button.dataset.attachmentId === id && available(button)) : null
  return current ?? [...root?.closest('.ai-msg')?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []].find(available) ?? null
}

export function MessageAttachments({ accountId, conversationId, attachments, onCopy, editing = false, previewOnly = false, onRemove }: {
  accountId: string
  conversationId: string | null
  attachments: AttachmentMeta[]
  onCopy: (text: string) => void
  editing?: boolean
  previewOnly?: boolean
  onRemove?: (id: string) => void
}): React.JSX.Element {
  const images = attachments.filter((a) => a.kind === 'image')
  const files = attachments.filter((a) => a.kind === 'file')
  const [imageIndex, setImageIndex] = useState<number | null>(null)
  const [fullImage, setFullImage] = useState<{ id: string; url: string } | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [fileText, setFileText] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(() => new Set())
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerId = useRef<string | null>(null)
  const restoreFocus = useRef(false)
  const previousOpen = useRef<number | null>(null)
  const imageId = imageIndex === null ? null : images[imageIndex]?.id ?? null
  useEffect(() => {
    if (!imageId || !conversationId) return
    let cancelled = false
    setFullImage(null)
    setError('')
    void window.api.ai.attachmentGet(accountId, conversationId, imageId).then((result) => {
      if (!cancelled) result.kind === 'image' ? setFullImage({ id: imageId, url: result.dataUrl }) : setError('无法读取这张图片')
    }).catch(() => { if (!cancelled) setError('无法读取这张图片') })
    return () => { cancelled = true }
  }, [accountId, conversationId, imageId, retry])
  useEffect(() => {
    if (!openFile || !conversationId) return
    let cancelled = false
    setFileText('')
    setError('')
    void window.api.ai.attachmentGet(accountId, conversationId, openFile).then((result) => {
      if (!cancelled) result.kind === 'file' ? setFileText(result.text) : setError('无法读取文件')
    }).catch(() => { if (!cancelled) setError('无法读取文件') })
    return () => { cancelled = true }
  }, [accountId, conversationId, openFile])
  const open = imageIndex !== null
  useEffect(() => {
    if (lightboxOpened(previousOpen.current, imageIndex)) closeRef.current?.focus()
    previousOpen.current = imageIndex
  }, [open])
  useLayoutEffect(() => {
    if (!open || !dialogRef.current) return
    const changed: { element: HTMLElement; inert: boolean; hidden: string | null }[] = []
    let child: HTMLElement = dialogRef.current
    const panel = child.closest<HTMLElement>('.ai-panel')
    while (child.parentElement && child !== panel) {
      for (const sibling of child.parentElement.children) if (sibling !== child && sibling instanceof HTMLElement) {
        changed.push({ element: sibling, inert: sibling.inert, hidden: sibling.getAttribute('aria-hidden') })
        sibling.inert = true
        sibling.setAttribute('aria-hidden', 'true')
      }
      child = child.parentElement
    }
    return () => {
      for (const { element, inert, hidden } of changed) { element.inert = inert; if (hidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', hidden) }
      // JSX must not also set inert: restore the background first, then wait for the dialog's removal before focus().
      if (restoreFocus.current) {
        restoreFocus.current = false
        requestAnimationFrame(() => attachmentFocusTarget(rootRef.current, triggerId.current)?.focus())
      }
    }
  }, [open])
  const close = (): void => { restoreFocus.current = true; setImageIndex(null) }
  return <div ref={rootRef} className="ai-msg-attachments">
    {images.length > 0 && <div className="ai-msg-images">{images.map((a, index) => <div className="ai-msg-image-wrap" key={a.id}>
      <button type="button" data-attachment-id={a.id} disabled={!conversationId || editing || previewOnly} title={a.name} onClick={() => { triggerId.current = a.id; setImageIndex(index) }}><span className="ai-msg-image-frame">{failedThumbs.has(a.id) || !safeImageSrc(a.thumbDataUrl) ? <span className="ai-msg-image-fallback" role="img" aria-label="无法显示"><span aria-hidden="true">▧</span>无法显示</span> : <img src={safeImageSrc(a.thumbDataUrl)} alt="" onError={() => setFailedThumbs((failed) => new Set(failed).add(a.id))} />}</span><span className="ai-msg-image-caption">{a.name}</span></button>
      {editing && <button type="button" aria-label={`移除附件 ${a.name}`} onClick={() => onRemove?.(a.id)}>×</button>}
    </div>)}</div>}
    {files.map((a) => <div className="ai-msg-file" key={a.id}>
      <button type="button" disabled={!conversationId || editing || previewOnly} aria-expanded={openFile === a.id} onClick={() => setOpenFile(openFile === a.id ? null : a.id)}>▤ {a.name} · {formatSize(a.size)}</button>
      {editing && <button type="button" aria-label={`移除附件 ${a.name}`} onClick={() => onRemove?.(a.id)}>×</button>}
      {Boolean(a.redactions) && <small>已隐藏 {a.redactions} 处疑似密钥</small>}
      {a.truncated && <small>已截断</small>}
      {openFile === a.id && <div className="ai-file-preview">{error || fileText ? <><pre>{error || fileText}</pre>{fileText && <button type="button" onClick={() => onCopy(fileText)}>复制</button>}</> : '正在读取…'}</div>}
    </div>)}
    {imageIndex !== null && images[imageIndex] && <div ref={dialogRef} className="ai-lightbox" onClick={(e) => { if (e.target === e.currentTarget) close() }} role="dialog" aria-modal="true" aria-label={`查看图片 ${images[imageIndex].name}`} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setImageIndex((i) => i === null ? null : Math.max(0, i - 1)) }
      if (e.key === 'ArrowRight') { e.preventDefault(); setImageIndex((i) => i === null ? null : Math.min(images.length - 1, i + 1)) }
      if (e.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (!buttons?.length) return
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }}>
      <div className="ai-lightbox-content">
        <div className="ai-lightbox-header"><div className="ai-lightbox-title" title={images[imageIndex].name}>{images[imageIndex].name} · {formatSize(images[imageIndex].size)} · {imageIndex + 1} / {images.length}</div><button ref={closeRef} type="button" onClick={close} aria-label="关闭图片预览">×</button></div>
        <div className="ai-lightbox-view">
          {images.length > 1 && <button type="button" className="ai-lightbox-prev" disabled={imageIndex === 0} onClick={() => setImageIndex(imageIndex - 1)} aria-label="上一张">←</button>}
          <div className="ai-lightbox-stage">{fullImage?.id === imageId && safeImageSrc(fullImage.url) ? <img src={safeImageSrc(fullImage.url)} alt={images[imageIndex].name} onError={() => { setFullImage(null); setError('无法显示这张图片') }} /> : error ? <div className="ai-lightbox-error" role="alert">{error}<button type="button" onClick={() => setRetry((n) => n + 1)}>重试</button></div> : <div className="ai-lightbox-skeleton" role="status" aria-label="正在读取图片" />}</div>
          {images.length > 1 && <button type="button" className="ai-lightbox-next" disabled={imageIndex === images.length - 1} onClick={() => setImageIndex(imageIndex + 1)} aria-label="下一张">→</button>}
        </div>
      </div>
    </div>}
  </div>
}
