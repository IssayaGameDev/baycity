import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * The assistant's text as HTML (ADR 0192): Markdown by `marked`, then through DOMPurify, so whatever the model writes —
 * or a file it quotes — cannot run in the editor. Links open in a tab of their own.
 *
 * **Where DOMPurify cannot run it would hand the HTML back untouched**, so there the text is shown as plain text and
 * no HTML is made at all: safe first, pretty second.
 */

marked.setOptions({ gfm: true, breaks: true })

let hooked = false
const hookLinks = (): void => {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

/** Text as text: every character that could open a tag or an entity escaped. */
export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '<br>')

export const renderMarkdown = (text: string): string => {
  if (!DOMPurify.isSupported) return escapeHtml(text)
  hookLinks()
  const html = marked.parse(text, { async: false })
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'img'] })
}
