// src/components/ui.jsx — shared primitives.
export function StatusPill({ kind, children }) {
  const cls = { ok: 'st-ok', warn: 'st-warn', alert: 'st-alert', idle: 'st-idle' }[kind] || 'st-idle';
  return <span className={`pill ${cls}`}><span className={`dot ${cls}`} />{children}</span>;
}

export function Modal({ title, onClose, children, footer }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Loader({ label = 'Loading…' }) {
  return <div className="empty"><p className="muted">{label}</p></div>;
}

export function Empty({ title, children }) {
  return <div className="empty"><h3>{title}</h3><p className="muted">{children}</p></div>;
}
