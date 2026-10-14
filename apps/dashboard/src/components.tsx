// Small shared pieces.
import { useState } from 'react';

/** "3 min ago" for recent times, a local date otherwise. */
export function when(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 0) return new Date(iso).toLocaleString();
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * A value shown once (new API key, invite link) with a copy button. The Clipboard API needs a secure
 * context (https or localhost); on plain http (k3d via nip.io) it falls back to selecting the text.
 */
export function SecretOnce({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState<'yes' | 'select' | ''>('');
  let input: HTMLInputElement | null = null;
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(value);
      setCopied('yes');
    } catch {
      input?.select();
      setCopied(document.execCommand?.('copy') ? 'yes' : 'select');
    }
  };
  return (
    <div className="once" role="status">
      <label>
        {label}
        <span className="row">
          <input readOnly value={value} ref={(el) => { input = el; }} onFocus={(e) => e.target.select()} spellCheck={false} className="mono" />
          <button type="button" onClick={copy}>{copied === 'yes' ? 'Copied' : 'Copy'}</button>
        </span>
      </label>
      <p className="small muted">{copied === 'select' ? 'Selected — press Ctrl+C to copy. ' : ''}{note}</p>
    </div>
  );
}
