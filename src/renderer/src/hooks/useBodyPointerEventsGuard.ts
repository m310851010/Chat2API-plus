import { useEffect } from 'react'

const MODAL_LAYER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]'

/**
 * Workaround for a Radix UI race condition: when a modal dialog opens from a
 * context menu (or one modal layer unmounts while another is still closing),
 * DismissableLayer can restore `pointer-events: none` onto document.body after
 * every layer is already gone, freezing the entire UI.
 *
 * This guard watches for the "no modal layers open + body still locked" state
 * and clears the stale style.
 */
export function useBodyPointerEventsGuard(): void {
  useEffect(() => {
    const unlock = () => {
      const body = document.body
      if (body.style.pointerEvents !== 'none') return
      if (body.querySelector(MODAL_LAYER_SELECTOR)) return
      body.style.pointerEvents = ''
    }

    const observer = new MutationObserver(unlock)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style'],
    })
    unlock()

    return () => observer.disconnect()
  }, [])
}
