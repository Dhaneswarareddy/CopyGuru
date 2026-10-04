'use client';
import { useRef, useState } from 'react';
import { DEMO_SAMPLES } from '@/lib/domain/demoSamples';
import type { SubmissionSource } from '@/lib/domain/types';
import { Button } from '@/components/ui/Button';

export interface PickedImage {
  file: File;
  source: SubmissionSource;
}

interface SourceProps {
  onPick(image: PickedImage): void;
  onError(message: string): void;
  disabled: boolean;
}

interface ImageSource {
  key: string;
  /** Whether this source is offered in the current session. */
  available(ctx: { isDemo: boolean }): boolean;
  Component(props: SourceProps): React.ReactNode;
}

function FileSource({ label, source, capture, onPick, disabled }: SourceProps & { label: string; source: SubmissionSource; capture?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        capture={capture ? 'environment' : undefined}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick({ file, source });
          e.target.value = ''; // allow picking the same file again
        }}
      />
      <Button variant="secondary" disabled={disabled} onClick={() => ref.current?.click()}>
        {label}
      </Button>
    </>
  );
}

function SampleSource({ onPick, onError, disabled }: SourceProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  async function pick(sample: (typeof DEMO_SAMPLES)[number]) {
    setLoading(sample.file);
    try {
      const res = await fetch(sample.file);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      onPick({ file: new File([blob], sample.file.split('/').pop()!, { type: blob.type }), source: 'sample' });
      setOpen(false);
    } catch {
      onError('Could not load that sample image.');
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      <Button variant="secondary" disabled={disabled} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Sample photos
      </Button>
      {open && (
        <div className="basis-full rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs text-slate-600">Demo photos. Several show the same subject in different pictures, so you can watch the matching work.</p>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {DEMO_SAMPLES.map((s) => (
              <li key={s.file}>
                <button type="button" onClick={() => pick(s)} disabled={!!loading} className="block w-full overflow-hidden rounded-lg bg-white text-left ring-1 ring-slate-200 hover:ring-indigo-400">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.file} alt={s.label} loading="lazy" className={`h-16 w-full object-cover ${loading === s.file ? 'opacity-50' : ''}`} />
                  <span className="block truncate px-1.5 pt-1 text-[11px] font-medium text-slate-800">{s.label}</span>
                  <span className="block truncate px-1.5 pb-1 text-[10px] text-slate-500">{s.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * Registry of ways to provide a question image. To add an input mechanism
 * (host-supplied question, URL import, clipboard…), append an entry.
 */
export const IMAGE_SOURCES: ImageSource[] = [
  { key: 'upload', available: () => true, Component: (p) => <FileSource {...p} label="Upload image" source="upload" /> },
  { key: 'camera', available: () => true, Component: (p) => <FileSource {...p} label="Take photo" source="camera" capture /> },
  { key: 'sample', available: ({ isDemo }) => isDemo, Component: (p) => <SampleSource {...p} /> },
];

export function ImageInput({ isDemo, ...props }: SourceProps & { isDemo: boolean }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {IMAGE_SOURCES.filter((s) => s.available({ isDemo })).map((s) => (
        <s.Component key={s.key} {...props} />
      ))}
    </div>
  );
}
