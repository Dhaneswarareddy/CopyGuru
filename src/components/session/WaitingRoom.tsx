'use client';
import { useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import { SESSION_SETTINGS_SCHEMA, type SettingField } from '@/lib/domain/settings';
import { ParticipantList } from '@/components/participants/ParticipantList';
import { InviteCard } from './InviteCard';
import { Card, ErrorNote } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useSession } from './SessionProvider';

export function WaitingRoom() {
  const { state, call, refresh, code } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/sessions/${code}/start`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const settings = state.session.settings as unknown as Record<string, unknown>;
  const describe = (f: SettingField) => {
    const v = settings[f.key];
    if (f.type === 'toggle') return v ? 'On' : 'Off';
    return f.options.find((o) => o.value === v)?.label ?? String(v);
  };

  return (
    <div className="space-y-4">
      <Card className="p-6 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Waiting room · share this code</p>
        <p className="brand-text mt-2 font-mono text-5xl font-bold tracking-[0.3em]">{state.session.code}</p>
        <p className="mt-2 text-sm text-slate-600">
          {state.caps.canStart
            ? 'Start when everyone is here. People can still join after you start.'
            : 'You are in. The host will start the session shortly.'}
        </p>
        {state.caps.canStart && (
          <div className="mt-4 space-y-3">
            <ErrorNote>{error}</ErrorNote>
            <Button size="lg" onClick={start} busy={busy}>
              Start session
            </Button>
          </div>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Participants ({state.participants.length})</h2>
        <ParticipantList
          participants={state.participants}
          onRemove={
            state.caps.canRemoveParticipants
              ? async (p) => {
                  await call(`/api/sessions/${code}/participants/${p.id}/remove`, { method: 'POST' });
                  await refresh();
                }
              : undefined
          }
        />
      </Card>
      {state.caps.canStart && <InviteCard />}
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Session settings</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {(SESSION_SETTINGS_SCHEMA as readonly SettingField[]).map((f) => (
            <div key={f.key} className="flex justify-between gap-3 border-b border-slate-100 py-1">
              <dt className="text-slate-600">{f.label}</dt>
              <dd className="font-medium text-slate-900">{describe(f)}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
