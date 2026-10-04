'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/client/api';
import type { QuestionListView } from '@/lib/domain/views';
import { useLiveReload, useSession } from '@/components/session/SessionProvider';
import { ErrorNote, inputClass } from '@/components/ui/Badge';
import { Button, Spinner } from '@/components/ui/Button';
import { QuestionCard } from './QuestionCard';

const PAGE = 20;

/** The session's shared, live knowledge board. */
export function QuestionsTab() {
  const { call, code, openQuestion, setTab } = useSession();
  const [filter, setFilter] = useState('ALL');
  const [sort, setSort] = useState('NEWEST');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [data, setData] = useState<QuestionListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const p = new URLSearchParams({ filter, sort, limit: String(limit) });
      if (query) p.set('search', query);
      const res = await call<QuestionListView>(`/api/sessions/${code}/questions?${p}`);
      if (id !== requestId.current) return; // a newer request superseded this one
      setData(res);
      setError(null);
    } catch (err) {
      if (id === requestId.current) setError(errorMessage(err));
    }
  }, [call, code, filter, sort, query, limit]);

  useEffect(() => {
    void load();
  }, [load]);
  // any question-related event (or a reconnect) refreshes the visible page
  useLiveReload(load, (e) => e.type !== 'PRESENCE_CHANGED' && e.type !== 'PARTICIPANT_JOINED');

  const filters = data?.filters ?? [{ key: 'ALL', label: 'All' }];
  const sorts = data?.sorts ?? [{ key: 'NEWEST', label: 'Newest' }];
  const narrowed = filter !== 'ALL' || !!query;

  return (
    <section aria-label="Questions" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          className={inputClass}
          placeholder="Search by answer or question number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search questions"
        />
        <select className={`${inputClass} sm:w-52`} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort questions">
          {sorts.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter questions">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => {
              setFilter(f.key);
              setLimit(PAGE);
            }}
            aria-pressed={filter === f.key}
            className={`shrink-0 rounded-full px-3 py-1 text-sm font-medium ${
              filter === f.key ? 'bg-linear-to-r from-violet-600 to-fuchsia-600 text-onaccent shadow-sm shadow-fuchsia-500/30' : 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ErrorNote>{error}</ErrorNote>
      {!data && !error && (
        <div className="flex justify-center py-10 text-indigo-600">
          <Spinner className="h-6 w-6" />
        </div>
      )}
      {data && data.items.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          {narrowed ? (
            <>
              <p className="text-sm font-medium text-slate-800">No questions match.</p>
              <p className="mt-1 text-sm text-slate-500">Try another filter or clear the search.</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-800">No questions yet.</p>
              <p className="mt-1 text-sm text-slate-500">The first picture someone posts becomes Question #1.</p>
              <Button className="mt-3" onClick={() => setTab('play')}>
                Post the first one
              </Button>
            </>
          )}
        </div>
      )}
      {data && data.items.length > 0 && (
        <>
          <p className="text-xs text-slate-500" aria-live="polite">
            {data.total} {data.total === 1 ? 'question' : 'questions'} · updates live
          </p>
          <ul className="space-y-3">
            {data.items.map((q) => (
              <li key={q.id}>
                <QuestionCard q={q} onOpen={() => openQuestion(q.id)} />
              </li>
            ))}
          </ul>
          {data.total > data.items.length && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setLimit((l) => l + PAGE)}>
                Show more ({data.total - data.items.length} left)
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
