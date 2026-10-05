/**
 * Nalgorithm Web — starters for the interests field
 *
 * A few editable phrases under the prompt, for a reader facing an empty box.
 * They only add text the reader can see and change; nothing is inferred.
 */

const STARTERS = [
  'Bitcoin and Lightning development',
  'Privacy and security tools',
  'Thoughtful longform posts',
  'Not: price talk, GM posts or ads',
]

export function initPromptStarters(field: HTMLTextAreaElement, holder: HTMLElement): void {
  for (const text of STARTERS) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'starter'
    chip.textContent = `+ ${text}`
    chip.setAttribute('aria-label', `Add “${text}” to your words`)
    chip.addEventListener('click', () => {
      const current = field.value.trim()
      if (current.toLowerCase().includes(text.toLowerCase())) return field.focus()
      const joined = current ? `${current.replace(/[.,;]?$/, '.')} ${text}.` : `${text}.`
      if (field.maxLength > 0 && joined.length > field.maxLength) return field.focus()
      field.value = joined
      // Counters, drafts and dirty markers listen for input.
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.focus()
    })
    holder.appendChild(chip)
  }
}
