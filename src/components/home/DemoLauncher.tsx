'use client';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/client/api';
import { getStoredDemo, storeDemo, type StoredDemo } from '@/lib/client/tokenStore';
import { Card, ErrorNote } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/**
 * Development / demo mode. Creates a seeded session and offers one link per
 * identity; each link opens that identity in its own window or tab, so the
 * whole flow can be shown on one machine.
 */
export function DemoLauncher() {
  const [demo, setDemo] = useState<StoredDemo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDemo(getStoredDemo()), []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<StoredDemo>('/api/sessions/demo', { method: 'POST' });
      storeDemo(res);
      setDemo(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const open = (token: string, name: string) =>
    window.open(`/s/${demo!.code}#token=${encodeURIComponent(token)}`, `vqa-${demo!.code}-${name}`, 'width=480,height=860');

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-base font-semibold text-slate-900">Try it without a group</h2>
      <p className="mt-1 text-sm text-slate-600">
        Creates a started session with a host, three participants and a few questions already posted. Open several identities side by side to watch
        updates arrive live.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={create} busy={busy} variant={demo ? 'secondary' : 'primary'}>
          {busy ? 'Setting up (analysing sample images)…' : demo ? 'Create a fresh demo session' : 'Create demo session'}
        </Button>
        <ErrorNote>{error}</ErrorNote>
      </div>
      {demo && (
        <div className="mt-4 rounded-lg bg-slate-50 p-4">
          <p className="text-sm text-slate-700">
            Demo session <span className="font-mono font-semibold tracking-wider">{demo.code}</span> — open each identity in its own window:
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {demo.identities.map((i) => (
              <Button key={i.name} variant="secondary" size="sm" onClick={() => open(i.token, i.name)}>
                Open as {i.name}
              </Button>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Suggested: as Participant B, go to Play → Sample photos → “Dog (another photo)”, answer “Labrador”, then challenge. Watch the other windows.
          </p>
        </div>
      )}
    </Card>
  );
}
