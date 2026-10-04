'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/client/api';
import { saveToken, storePendingRequest } from '@/lib/client/tokenStore';
import type { SessionView } from '@/lib/domain/views';
import { Card, ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export function JoinSessionForm() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ session: SessionView; token: string }>(`/api/sessions/${encodeURIComponent(code.trim())}/join`, {
        json: { displayName: name },
      });
      saveToken(res.session.code, res.token);
      router.push(`/s/${res.session.code}`);
    } catch (err) {
      // the host approves everyone: ask to join instead and wait in "Happening now"
      if (err instanceof ApiError && err.code === 'APPROVAL_REQUIRED') {
        try {
          const req = await api<{ token: string; sessionName: string }>(`/api/sessions/${encodeURIComponent(code.trim())}/join-requests`, {
            json: { displayName: name },
          });
          storePendingRequest({ token: req.token, sessionId: '', sessionName: req.sessionName, displayName: name.trim() });
          window.dispatchEvent(new Event('vqa:join-request'));
          setCode('');
          setBusy(false);
          return;
        } catch (inner) {
          setError(errorMessage(inner));
          setBusy(false);
          return;
        }
      }
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-slate-900">Join a session</h2>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <div>
          <label htmlFor="join-code" className="mb-1 block text-sm font-medium text-slate-700">
            Session code
          </label>
          <input
            id="join-code"
            className={`${inputClass} font-mono uppercase tracking-widest`}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            maxLength={12}
            placeholder="ABC123"
            autoComplete="off"
            required
          />
        </div>
        <div>
          <label htmlFor="join-display-name" className="mb-1 block text-sm font-medium text-slate-700">
            Your name
          </label>
          <input id="join-display-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Sam" required />
        </div>
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" block busy={busy} disabled={code.length < 4 || !name.trim()}>
          Join session
        </Button>
      </form>
    </Card>
  );
}
