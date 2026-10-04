'use client';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useSession } from './SessionProvider';

/** Invite link, copy button and a QR code people can scan from a shared screen. */
export function InviteCard() {
  const { state } = useSession();
  const [link, setLink] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const url = `${window.location.origin}/s/${state.session.code}`;
    setLink(url);
    // fixed dark-on-white: scanners need the contrast, whatever the theme
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#1e1b4b', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [state.session.code]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the link is shown and can be selected by hand */
    }
  }

  return (
    <Card className="flex flex-col items-center gap-4 p-4 sm:flex-row sm:items-start">
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt={`QR code to join session ${state.session.code}`} className="h-36 w-36 shrink-0 rounded-xl border border-slate-200 bg-[#fff] p-1" />
      ) : (
        <div className="h-36 w-36 shrink-0 rounded-xl bg-slate-100" />
      )}
      <div className="min-w-0 flex-1 text-center sm:text-left">
        <h2 className="text-sm font-semibold text-slate-900">Invite people</h2>
        <p className="mt-1 text-sm text-slate-600">
          Scan the code, or open the link and enter a name.
          {state.session.settings.approveAllJoins ? ' You approve each person before they get in.' : ' Anyone with the link can join.'}
        </p>
        <p className="mt-2 break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">{link}</p>
        <div className="mt-2 flex items-center justify-center gap-3 sm:justify-start">
          <Button size="sm" variant="secondary" onClick={copy}>
            Copy link
          </Button>
          <span className="text-xs text-slate-500" aria-live="polite">
            {copied ? 'Copied' : ''}
          </span>
        </div>
      </div>
    </Card>
  );
}
