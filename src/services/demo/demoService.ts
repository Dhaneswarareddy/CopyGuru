import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@/lib/config';
import { defaultSettings } from '@/lib/domain/settings';
import type { ParticipantRow } from '@/lib/domain/types';
import { forbidden } from '@/lib/http/errors';
import type { SessionService } from '@/services/sessions/sessionService';
import type { SubmissionService } from '@/services/submissions/submissionService';

export interface DemoIdentity {
  name: string;
  role: string;
  token: string;
}

/**
 * Development / demo mode: creates a started session with a host, three
 * participants and a few real submissions (run through the real matching
 * pipeline), and returns a token per identity so each can be opened in its own
 * browser window.
 */
export class DemoService {
  constructor(
    private d: { config: AppConfig; sessionService: SessionService; submissionService: SubmissionService },
  ) {}

  async create(): Promise<{ code: string; identities: DemoIdentity[]; seeded: number }> {
    if (!this.d.config.demoMode) throw forbidden('Demo mode is disabled on this server', 'DEMO_DISABLED');
    const { sessionService, submissionService } = this.d;
    const host = await sessionService.create({
      name: 'Demo session',
      hostName: 'Host',
      settings: defaultSettings(),
      isDemo: true,
    });
    const identities: DemoIdentity[] = [{ name: 'Host', role: 'HOST', token: host.token }];
    const people: Record<string, ParticipantRow> = { Host: host.participant };
    for (const name of ['Participant A', 'Participant B', 'Participant C']) {
      const joined = await sessionService.join(host.session.code, { displayName: name });
      identities.push({ name, role: 'PARTICIPANT', token: joined.token });
      people[name] = joined.participant;
    }
    const session = await sessionService.start(host.session, host.participant);

    const seed: [string, string, string][] = [
      ['Participant A', 'golden-1.jpg', 'Golden Retriever'],
      ['Participant C', 'eiffel-1.jpg', 'Paris'],
      ['Host', 'bridge-1.jpg', 'Golden Gate Bridge'],
    ];
    let seeded = 0;
    for (const [who, file, answer] of seed) {
      try {
        const image = await fs.readFile(path.join(process.cwd(), 'public', 'demo', file));
        await submissionService.submit(session, people[who], { image, answer, source: 'sample' });
        seeded++;
      } catch (err) {
        console.error(`[demo] could not seed ${file}:`, err instanceof Error ? err.message : err);
      }
    }
    return { code: session.code, identities, seeded };
  }
}
