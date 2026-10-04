'use client';
import { useState } from 'react';
import type { ParticipantView } from '@/lib/domain/views';
import { Badge } from '@/components/ui/Badge';

interface Props {
  participants: ParticipantView[];
  /** When given, each other participant gets a "Message" action (private chat). */
  onMessage?(participant: ParticipantView): void;
  /** When given, the host can remove other (non-host) participants. Rejects with a readable error. */
  onRemove?(participant: ParticipantView): Promise<void>;
}

export function ParticipantList({ participants, onMessage, onRemove }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(p: ParticipantView) {
    setBusy(true);
    setError(null);
    try {
      await onRemove!(p);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that person.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
      {participants.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${p.online ? 'bg-emerald-500' : 'bg-slate-300'}`}
            title={p.online ? 'Online' : 'Offline'}
          />
          <span className="truncate text-slate-800">
            {p.displayName}
            {p.isMe && <span className="text-slate-500"> (you)</span>}
          </span>
          {p.role !== 'PARTICIPANT' && <Badge tone="indigo">{p.role.charAt(0) + p.role.slice(1).toLowerCase()}</Badge>}
          {onMessage && !p.isMe && (
            <button
              type="button"
              onClick={() => onMessage(p)}
              aria-label={`Message ${p.displayName} privately`}
              className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
            >
              Message
            </button>
          )}
          {onRemove && !p.isMe && p.role !== 'HOST' && confirming !== p.id && (
            <button
              type="button"
              onClick={() => {
                setConfirming(p.id);
                setError(null);
              }}
              aria-label={`Remove ${p.displayName} from the session`}
              className={`${onMessage ? '' : 'ml-auto '}shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-50`}
            >
              Remove
            </button>
          )}
          {confirming === p.id && (
            <div className="basis-full rounded-lg bg-rose-50 p-2 text-xs text-rose-700">
              <p>Remove {p.displayName}? They lose access right away. Their answers stay.</p>
              <div className="mt-1.5 flex gap-2">
                <button type="button" disabled={busy} onClick={() => remove(p)} className="rounded bg-rose-600 px-2 py-1 font-semibold text-onaccent disabled:opacity-50">
                  {busy ? 'Removing…' : `Remove ${p.displayName}`}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirming(null)} className="rounded px-2 py-1 font-medium hover:bg-rose-50">
                  Keep
                </button>
              </div>
              {error && <p role="alert" className="mt-1">{error}</p>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
