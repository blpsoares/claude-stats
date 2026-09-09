/**
 * dismissOverlay.ts — PURE. When a click on a modal's backdrop really means "close this".
 *
 * The obvious spelling is `<div className="backdrop" onClick={onClose}>`, and it has a defect that
 * only shows up once there is a TEXT FIELD inside the dialog:
 *
 *   1. you press inside the description,
 *   2. you drag to select what you wrote,
 *   3. you release outside the dialog — over the backdrop, or anywhere else.
 *
 * The browser then fires ONE `click` on the nearest common ancestor of the press and the release,
 * which is the backdrop. The handler cannot tell that gesture from a deliberate click on the
 * backdrop, so the dialog closes and takes the half-written task with it. Reported exactly that
 * way: *"se eu clico no campo de descrição da tarefa ele simplesmente fecha o modal"*.
 *
 * The rule is therefore two conditions, and both are needed:
 *
 *  - the event's TARGET is the backdrop ITSELF, never a descendant — this alone already refuses
 *    the drag-out, because the common ancestor of a press inside the panel is the backdrop while
 *    the target of a real backdrop click is the backdrop;
 *  - the gesture STARTED on the backdrop too, which is what `pointerdown` records. A press that
 *    began inside the dialog is a selection, whatever it ends on.
 *
 * `useDismissOverlay` returns the props to spread on the backdrop element. A dialog using it needs
 * no `stopPropagation` on its own panel: nothing bubbling out of the panel can satisfy either
 * condition.
 */

import { useCallback, useRef } from 'react'

export interface OverlayDismissProps {
  onPointerDown: (e: { target: EventTarget | null; currentTarget: EventTarget | null }) => void
  onClick: (e: { target: EventTarget | null; currentTarget: EventTarget | null }) => void
}

/** The decision, without React. Exported so it can be tested on its own. */
export function shouldDismiss(o: {
  /** Did the gesture START on the backdrop? */
  startedOnBackdrop: boolean
  /** Is the click's target the backdrop itself? */
  targetIsBackdrop: boolean
}): boolean {
  return o.startedOnBackdrop && o.targetIsBackdrop
}

export function useDismissOverlay(onClose: () => void): OverlayDismissProps {
  // Whether the gesture that is now ending began on the backdrop. A ref and not state: it must not
  // re-render anything, and it is read once, synchronously, by the click that follows.
  const startedOnBackdrop = useRef(false)

  const onPointerDown = useCallback((e: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
    startedOnBackdrop.current = e.target === e.currentTarget
  }, [])

  const onClick = useCallback((e: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
    const ok = shouldDismiss({
      startedOnBackdrop: startedOnBackdrop.current,
      targetIsBackdrop: e.target === e.currentTarget,
    })
    startedOnBackdrop.current = false
    if (ok) onClose()
  }, [onClose])

  return { onPointerDown, onClick }
}
