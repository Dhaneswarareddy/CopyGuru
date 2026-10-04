'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getRecentSessions, type RecentSession } from '@/lib/client/tokenStore';

/**
 * Sessions this browser is still a member of. Going to the home page does not
 * leave a session, so this is the way back in. Renders nothing when there are none.
 */
export function YourSessions() {
  const [sessions, setSessions] = useState<RecentSession[]>([]);

  useEffect(() => setSessions(getRecentSessions()), []);

  if (sessions.length === 0) return null;
  return (
    <section aria-label="Your sessions" className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
      <h2 className="text-sm font-semibold text-slate-900">Your sessions</h2>
      <ul className="mt-2 space-y-2">
        {sessions.map((s) => (
          <li key={s.code} className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-sm text-slate-800">
              <span className="font-semibold">{s.name}</span>
              <span className="text-slate-500"> · you are {s.displayName}</span>
            </p>
            <Link
              href={`/s/${s.code}`}
              className="shrink-0 rounded-xl bg-linear-to-r from-violet-600 to-fuchsia-600 px-3 py-1.5 text-sm font-semibold text-onaccent shadow-sm shadow-fuchsia-500/25 hover:from-violet-500 hover:to-fuchsia-500"
            >
              Back to session
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
