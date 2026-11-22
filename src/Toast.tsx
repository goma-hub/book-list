import { createPortal } from "react-dom";

export type ToastNotice = { text: string; kind: "success" | "error" };

export function Toast({ notice, onClose, action }: {
  notice: ToastNotice | null;
  onClose: () => void;
  action?: { label: string; disabled?: boolean; onClick: () => void };
}) {
  if (!notice) return null;
  return createPortal(
    <div className={`toast toast-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      <span>{notice.text}</span>
      {action ? <button type="button" className="toast-action" disabled={action.disabled} onClick={action.onClick}>{action.label}</button> : null}
      {notice.kind === "error" ? <button type="button" className="toast-close" aria-label="通知を閉じる" onClick={onClose}>×</button> : null}
    </div>,
    document.body,
  );
}
