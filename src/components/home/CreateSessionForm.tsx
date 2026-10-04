'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/client/api';
import { saveToken } from '@/lib/client/tokenStore';
import { defaultSettings } from '@/lib/domain/settings';
import type { SessionView } from '@/lib/domain/views';
import { SettingsFields } from '@/components/session/SettingsFields';
import { Card, ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/** The settings section is rendered from SESSION_SETTINGS_SCHEMA: adding a
 *  setting to the schema makes it appear here with no UI change. */
export function CreateSessionForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [hostName, setHostName] = useState('');
  const [settings, setSettings] = useState<Record<string, unknown>>(defaultSettings() as unknown as Record<string, unknown>);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ session: SessionView; token: string }>('/api/sessions', { json: { name, hostName, settings } });
      saveToken(res.session.code, res.token);
      router.push(`/s/${res.session.code}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const set = (key: string, value: unknown) => setSettings((s) => ({ ...s, [key]: value }));

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-slate-900">Host a session</h2>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <div>
          <label htmlFor="session-name" className="mb-1 block text-sm font-medium text-slate-700">
            Session name
          </label>
          <input id="session-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Friday quiz" required />
        </div>
        <div>
          <label htmlFor="host-name" className="mb-1 block text-sm font-medium text-slate-700">
            Your name
          </label>
          <input id="host-name" className={inputClass} value={hostName} onChange={(e) => setHostName(e.target.value)} maxLength={40} placeholder="e.g. Alex" required />
        </div>

        <button type="button" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings} className="text-sm font-medium text-indigo-600 hover:underline">
          {showSettings ? 'Hide settings' : 'Session settings'}
        </button>
        {showSettings && (
          <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
            <legend className="sr-only">Session settings</legend>
            <SettingsFields values={settings} onChange={set} idPrefix="setting" />
          </fieldset>
        )}
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" block busy={busy} disabled={!name.trim() || !hostName.trim()}>
          Create session
        </Button>
      </form>
    </Card>
  );
}
