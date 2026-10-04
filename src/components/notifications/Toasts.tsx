'use client';
import { useEffect } from 'react';
import type { NotificationView } from '@/lib/domain/views';
import { useSession } from '@/components/session/SessionProvider';
import { Button } from '@/components/ui/Button';
import { NOTIFICATION_ICON } from './NotificationBell';

/** Live pop-ups for incoming notifications. Challenges are the prominent ones. */
export function Toasts() {
  const { toasts } = useSession();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  );
}

function Toast({ toast }: { toast: NotificationView }) {
  const { dismissToast, openQuestion, markRead } = useSession();
  const isChallenge = toast.type === 'CHALLENGE';
  const data = toast.data as { originalAnswer?: string; challengerAnswer?: string; hidden?: boolean };

  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), isChallenge ? 12000 : 5000);
    return () => clearTimeout(timer);
  }, [toast.id, isChallenge, dismissToast]);

  function view() {
    markRead([toast.id]);
    dismissToast(toast.id);
    if (toast.questionId) openQuestion(toast.questionId);
  }

  return (
    <div
      role="status"
      className={`toast-in pointer-events-auto w-full max-w-sm rounded-xl border bg-white p-4 shadow-lg ${isChallenge ? 'border-amber-300' : 'border-slate-200'}`}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true">{NOTIFICATION_ICON[toast.type] ?? '🔔'}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{isChallenge ? 'New challenge' : toast.title}</p>
          {isChallenge ? (
            <>
              <p className="text-sm text-slate-700">{toast.body}</p>
              {data.originalAnswer !== undefined ? (
                <dl className="mt-2 space-y-1 text-sm">
                  <div>
                    <dt className="text-xs text-slate-500">Previous answer</dt>
                    <dd className="font-medium text-slate-900">{data.originalAnswer}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Challenger&apos;s answer</dt>
                    <dd className="font-medium text-slate-900">{data.challengerAnswer}</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-1 text-xs text-slate-500">Answer the question to see both answers.</p>
              )}
            </>
          ) : (
            toast.body && <p className="text-sm text-slate-600">{toast.body}</p>
          )}
          <div className="mt-3 flex gap-2">
            {toast.questionId && (
              <Button size="sm" variant={isChallenge ? 'warning' : 'secondary'} onClick={view}>
                View question
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => dismissToast(toast.id)}>
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
