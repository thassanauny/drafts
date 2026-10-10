import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function Dialog({
  title,
  children,
  busy,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  busy: boolean;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>(
      '[autofocus]:not(:disabled), input:not([readonly]):not(:disabled), textarea:not([readonly]):not(:disabled), select:not(:disabled), .dialog-actions button:not(:disabled)',
    )?.focus();
  }, [title]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={wide ? 'dialog wide' : 'dialog'}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const outside =
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom;
        if (outside) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
