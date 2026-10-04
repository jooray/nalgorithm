import { deviceStorage } from './storage.js'
import { beginActivity } from './activity.js'

/** Tune drafts deliberately exclude passwords/keys and are scoped to identity + mode. */
export function initTuneDrafts(identity: () => string): void {
  const draftKey = `nalgorithm_tune_draft_${document.body.dataset.mode}_${identity()}`
  const key = () => draftKey
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('#view-tune input[id], #view-tune textarea[id], #view-tune select[id]')]
    .filter((f) => f.type !== 'password' && !f.id.includes('api-key') && (!('readOnly' in f) || !f.readOnly))
    .filter((f) => !(f.closest('.byok-only') && document.body.dataset.mode !== 'byok') && !(f.closest('.hosted-only') && document.body.dataset.mode !== 'hosted'))
  const dirty = new Map<string, string | boolean>()
  let finish: (() => void) | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  const save = (): void => {
    if (dirty.size) deviceStorage.setItem(key(), JSON.stringify(Object.fromEntries(dirty)))
    else deviceStorage.removeItem(key())
  }
  try {
    const values = JSON.parse(deviceStorage.getItem(key()) ?? 'null')
    if (values) {
      for (const field of fields) if (field.id in values) {
        if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = values[field.id] === true
        else field.value = String(values[field.id])
        dirty.set(field.id, values[field.id])
      }
      const status = document.getElementById('tune-status')
      if (status) status.textContent = 'Restored an unsaved draft. Save to apply it; Refresh uses saved settings.'
    }
  } catch { /* malformed draft cannot prevent setup */ }
  for (const field of fields) field.addEventListener('input', () => {
    dirty.set(field.id, field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value)
    finish?.(); finish = beginActivity('editing preferences')
    clearTimeout(idle); idle = setTimeout(() => { save(); finish?.(); finish = undefined }, 30_000)
    save()
    const status = document.getElementById('tune-status')
    if (status) status.textContent = 'Unsaved preferences. Use the Save button for the section you changed.'
  })
  window.addEventListener('nalgorithm:checkpoint', save)
  document.addEventListener('nalgorithm:settings-saved', (event) => {
    const schedule = (event as CustomEvent).detail?.section === 'schedule'
    for (const id of dirty.keys()) if (id.startsWith('digest-') === schedule) dirty.delete(id)
    save(); finish?.(); finish = undefined; clearTimeout(idle)
    if (dirty.size) {
      const status = document.getElementById('tune-status')
      if (status) status.textContent = 'This section is saved; changes in another section are still unsaved.'
    }
  })
}
