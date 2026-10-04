'use client';
import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { useChat } from './ChatProvider';

/** A brief pop-up when a private message arrives while its conversation is not on screen. */
export function ChatAlert() {
  const { alert, dismissAlert, show } = useChat();

  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(dismissAlert, 8000);
    return () => clearTimeout(timer);
  }, [alert, dismissAlert]);

  if (!alert) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-24 z-50 flex justify-center px-4">
      <div role="status" className="toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-indigo-200 bg-white p-3 shadow-lg">
        <span aria-hidden="true">🔒</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">Private message from {alert.senderName}</p>
          <p className="truncate text-sm text-slate-600">{alert.text}</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            show(alert.senderId);
            dismissAlert();
          }}
        >
          Reply
        </Button>
        <button type="button" onClick={dismissAlert} aria-label="Dismiss" className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
          ✕
        </button>
      </div>
    </div>
  );
}
