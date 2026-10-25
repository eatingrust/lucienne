import { useEffect, useRef } from 'react';
import { seconds } from './model.js';

/** Native dialog makes the background inert and restores focus when it closes. */
export function ClosingDialog({ remainingMs, disabled, onReset }: { remainingMs: number; disabled: boolean; onReset: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className="closing" aria-labelledby="closing-heading" onCancel={event => event.preventDefault()}>
    <h2 id="closing-heading">Exploration finished</h2>
    <p role="timer" aria-live="off">Reset in {seconds(remainingMs)} seconds.</p>
    <p>The coordinator will restore the workspace and return to the desktop.</p>
    <button autoFocus disabled={disabled} onClick={onReset}>Reset now</button>
  </dialog>;
}
