'use client';
import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import { parseSettings } from '@/lib/domain/settings';
import { InviteCard } from '@/components/session/InviteCard';
import { useSession } from '@/components/session/SessionProvider';
import { SettingsFields } from '@/components/session/SettingsFields';
import { Card, ErrorNote } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/** Host-only tools on the Host tab: invite, live settings, results export. */
export function HostTools() {
  const { state, call, code, refresh, token } = useSession();
  const saved = parseSettings(state.session.settings) as unknown as Record<string, unknown>;
  const [draft, setDraft] = useState(saved);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'save' | 'export' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // pick up changes made elsewhere (another host window) unless this form is being edited
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    if (!open) setDraft(JSON.parse(savedKey));
  }, [savedKey, open]);

  const dirty = JSON.stringify(draft) !== savedKey;

  async function save() {
    setBusy('save');
    setError(null);
    try {
      await call(`/api/sessions/${code}/settings`, { json: { settings: draft } });
      await refresh();
      setNote('Settings saved. They apply to everyone straight away.');
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function exportCsv() {
    setBusy('export');
    setError(null);
    try {
      // fetched (not a plain link) because the request needs the session token
      const res = await fetch(`/api/sessions/${code}/export`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('The export could not be created.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${code}-results.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="space-y-4">
      <InviteCard />

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-900">Results</h2>
            <p className="text-sm text-slate-600">Every answer with its question, who gave it and the consensus, as a spreadsheet file.</p>
          </div>
          <Button variant="secondary" busy={busy === 'export'} onClick={exportCsv}>
            Download results (CSV)
          </Button>
        </div>
      </Card>

      {state.caps.canManageSettings && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-slate-900">Session settings</h2>
              <p className="text-sm text-slate-600">Change chat, challenges, visibility and who can join while the session runs.</p>
            </div>
            <Button variant="secondary" onClick={() => { setOpen((v) => !v); setNote(null); }} aria-expanded={open}>
              {open ? 'Close' : 'Edit settings'}
            </Button>
          </div>
          {note && !open && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{note}</p>}
          {open && (
            <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
              <SettingsFields values={draft} onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))} idPrefix="live-setting" disabled={busy === 'save'} />
              <div className="flex gap-2">
                <Button busy={busy === 'save'} disabled={!dirty} onClick={save}>
                  Save settings
                </Button>
                <Button variant="ghost" disabled={busy === 'save'} onClick={() => { setOpen(false); setDraft(saved); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}
