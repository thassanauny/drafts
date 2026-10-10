import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({ title, subtitle, children, onClose }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    const restore = document.activeElement as HTMLElement | null
    element.showModal()
    element.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
    return () => { element.close(); restore?.focus() }
  }, [])
  return <dialog ref={dialog} className="modal" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose() } }} aria-labelledby="modal-title">
    <div className="modal-heading"><div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>
    {children}
  </dialog>
}
