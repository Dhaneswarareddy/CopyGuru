import { CreateSessionForm } from '@/components/home/CreateSessionForm';
import { DemoLauncher } from '@/components/home/DemoLauncher';
import { JoinSessionForm } from '@/components/home/JoinSessionForm';
import { OngoingSessions } from '@/components/home/OngoingSessions';
import { YourSessions } from '@/components/home/YourSessions';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { loadConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const { demoMode } = loadConfig();
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <p className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-indigo-700 shadow-sm ring-1 ring-inset ring-indigo-200">
            <span aria-hidden="true">✨</span> Live · visual · together
          </p>
          <ThemeToggle className="bg-white shadow-sm ring-1 ring-inset ring-slate-200" />
        </div>
        <h1 className="brand-text mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">Visual Q&amp;A Sessions</h1>
        <p className="mt-3 max-w-2xl text-base text-slate-600 sm:text-lg">
          Everyone posts a picture and an answer. When two people post the same thing — even as completely different photos — the
          session recognises it, shows the earlier answer, and lets you agree or challenge it. Live, for the whole room.
        </p>
        <ul className="mt-4 flex flex-wrap gap-2 text-sm font-medium">
          <li className="rounded-full bg-indigo-50 px-3 py-1 text-indigo-700">📸 Photo matching</li>
          <li className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">⚡ Live challenges</li>
          <li className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">📊 Group consensus</li>
          <li className="rounded-full bg-rose-50 px-3 py-1 text-rose-700">💬 Chat</li>
        </ul>
      </header>
      <YourSessions />
      <OngoingSessions />
      <div className="grid gap-6 md:grid-cols-2">
        <JoinSessionForm />
        <CreateSessionForm />
      </div>
      {demoMode && <DemoLauncher />}
    </main>
  );
}
