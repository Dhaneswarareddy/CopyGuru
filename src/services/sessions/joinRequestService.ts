import crypto from 'node:crypto';
import type { AppConfig } from '@/lib/config';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import type { Db } from '@/lib/database/client';
import type { JoinRequestRow, JoinRequestsRepo } from '@/lib/database/repositories/joinRequests';
import type { SessionsRepo } from '@/lib/database/repositories/sessions';
import type { ParticipantRow, SessionRow } from '@/lib/domain/types';
import type { JoinRequestStatusView, JoinRequestView, PublicSessionView } from '@/lib/domain/views';
import type { EventBus } from '@/lib/events/bus';
import type { DomainEvent } from '@/lib/events/types';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '@/lib/http/errors';
import { Permission, authorize, roleHas } from '@/lib/permissions/permissions';
import type { RealtimeGateway } from '@/lib/realtime/gateway';
import type { SessionService } from './sessionService';

export interface JoinRequestDeps {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  sessions: SessionsRepo;
  joinRequests: JoinRequestsRepo;
  realtime: () => RealtimeGateway;
  sessionService: SessionService;
}

/** A request counts as "still waiting" while its page has polled this recently. */
export const REQUEST_FRESH_SECONDS = 30;
const MAX_PENDING_PER_SESSION = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public session list + "ask to join" (a waiting room).
 *
 *   visitor ──request──▶ PENDING ──host admits──▶ APPROVED (becomes a participant)
 *                           ├──────host declines─▶ DECLINED
 *                           └──────visitor leaves▶ CANCELLED
 *
 * The visitor receives their future participant token when they ask. It
 * authenticates nothing until a host approves: only then is a participant
 * created with that token's hash. So approval needs no second secret hand-off,
 * and a declined or abandoned request leaves a token that never works.
 *
 * Joining with the session code is unaffected: having the code is the invitation.
 */
export class JoinRequestService {
  constructor(private d: JoinRequestDeps) {}

  private isListed(session: SessionRow) {
    return session.settings.listedPublicly === true && !session.isDemo && session.status !== 'ENDED';
  }

  /** Sessions shown on the home page: listed, not over, and with someone present who can admit. */
  async listPublic(): Promise<PublicSessionView[]> {
    const sessions = await this.d.joinRequests.listListedSessions(60);
    const people = await this.d.joinRequests.participantsOf(sessions.map((s) => s.id));
    const realtime = this.d.realtime();
    const out: PublicSessionView[] = [];
    for (const s of sessions) {
      const members = people.filter((p) => p.sessionId === s.id);
      const online = new Set(realtime.onlineParticipantIds(s.id));
      const present = members.filter((m) => online.has(m.id));
      // nobody could let a visitor in → not worth offering
      if (!present.some((m) => roleHas(m.role, Permission.ADMIT_PARTICIPANTS))) continue;
      if (members.length >= this.d.config.limits.maxParticipants) continue;
      out.push({
        id: s.id,
        name: s.name,
        hostName: members.find((m) => m.role === 'HOST')?.displayName ?? 'Host',
        status: s.status,
        participantCount: members.length,
        onlineCount: present.length,
        createdAt: new Date(s.createdAt).toISOString(),
      });
    }
    return out.slice(0, 30);
  }

  /** A visitor asks to join a listed session. Returns the token they will use if admitted. */
  async request(sessionId: string, input: { displayName: unknown }) {
    const displayName = this.d.sessionService.cleanName(input.displayName, 'Your name');
    // Two ways in: the public id of a listed session, or (when the host approves
    // everyone) the session code itself. A code never works for a session that
    // lets code-holders join directly.
    const byId = UUID.test(sessionId) ? await this.d.sessions.findById(sessionId) : null;
    const byCode = !byId && /^[A-Za-z0-9]{4,12}$/.test(sessionId) ? await this.d.sessions.findByCode(sessionId.toUpperCase()) : null;
    const session = byId ?? byCode;
    const approvesAll = !!session && session.settings.approveAllJoins === true && session.status !== 'ENDED';
    if (!session || !((byId && this.isListed(session)) || approvesAll)) throw notFound('Session');
    const token = generateToken();

    const row = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      if (await this.d.sessions.nameTaken(session.id, displayName))
        throw conflict('That name is already taken in this session', 'NAME_TAKEN');
      if (await this.d.joinRequests.pendingNameTaken(session.id, displayName, REQUEST_FRESH_SECONDS))
        throw conflict('Someone with that name is already waiting to join', 'NAME_TAKEN');
      if ((await this.d.joinRequests.listPending(session.id, REQUEST_FRESH_SECONDS)).length >= MAX_PENDING_PER_SESSION)
        throw conflict('Too many people are waiting to join this session right now', 'QUEUE_FULL');
      return this.d.joinRequests.insert({
        id: crypto.randomUUID(),
        sessionId: session.id,
        displayName,
        tokenHash: hashToken(token),
      });
    });
    await this.d.bus.publish(this.event('JOIN_REQUESTED', row, null));
    return { requestId: row.id, token, sessionName: session.name };
  }

  /** Polled by the waiting visitor. Also tells hosts the visitor is still there. */
  async status(token: string | null): Promise<JoinRequestStatusView> {
    const { row, session } = await this.byToken(token);
    const closed = row.status === 'PENDING' && session.status === 'ENDED';
    return {
      status: closed ? 'CLOSED' : row.status,
      sessionName: session.name,
      code: row.status === 'APPROVED' ? session.code : null,
    };
  }

  async cancel(token: string | null): Promise<JoinRequestStatusView> {
    const { row, session } = await this.byToken(token);
    if (row.status === 'PENDING') {
      const updated = await this.d.joinRequests.setStatus(row.id, 'CANCELLED', null, null);
      await this.d.bus.publish(this.event('JOIN_REQUEST_CANCELLED', updated, null));
    }
    return this.status(token).catch(() => ({ status: 'CANCELLED' as const, sessionName: session.name, code: null }));
  }

  async listPending(session: SessionRow, viewer: ParticipantRow): Promise<JoinRequestView[]> {
    authorize(viewer, session, Permission.ADMIT_PARTICIPANTS);
    return (await this.d.joinRequests.listPending(session.id, REQUEST_FRESH_SECONDS)).map((r) => ({
      id: r.id,
      displayName: r.displayName,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  /** A host admits or declines. Admitting creates the participant. */
  async decide(session: SessionRow, actor: ParticipantRow, requestId: string, decision: unknown): Promise<JoinRequestView[]> {
    authorize(actor, session, Permission.ADMIT_PARTICIPANTS);
    if (decision !== 'APPROVE' && decision !== 'DECLINE') throw badRequest('Unknown decision');

    const events = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      const row = UUID.test(requestId) ? await this.d.joinRequests.findForUpdate(requestId) : null;
      // a request for another session is indistinguishable from a missing one
      if (!row || row.sessionId !== session.id) throw notFound('Join request');
      if (row.status !== 'PENDING') throw conflict('This request has already been handled', 'ALREADY_DECIDED');

      if (decision === 'DECLINE') {
        const declined = await this.d.joinRequests.setStatus(row.id, 'DECLINED', actor.id, null);
        return [this.event('JOIN_REQUEST_DECLINED', declined, actor.id)];
      }

      const fresh = (await this.d.sessions.findById(session.id))!;
      if (fresh.status === 'ENDED') throw conflict('This session has ended', 'SESSION_ENDED');
      if ((await this.d.sessions.countParticipants(session.id)) >= this.d.config.limits.maxParticipants)
        throw conflict('This session is full', 'SESSION_FULL');
      if (await this.d.sessions.nameTaken(session.id, row.displayName))
        throw conflict(`Someone called “${row.displayName}” joined in the meantime. Decline this request so they can pick another name.`, 'NAME_TAKEN');

      const userId = crypto.randomUUID();
      await this.d.sessions.insertUser(userId, row.displayName);
      // the token the visitor already holds becomes valid at this moment
      const tokenHash = (await this.d.db.one<{ tokenHash: string }>('SELECT token_hash FROM join_requests WHERE id = $1', [row.id]))!.tokenHash;
      const participant = await this.d.sessions.insertParticipant({
        id: crypto.randomUUID(),
        sessionId: session.id,
        userId,
        displayName: row.displayName,
        role: 'PARTICIPANT',
        tokenHash,
      });
      const approved = await this.d.joinRequests.setStatus(row.id, 'APPROVED', actor.id, participant.id);
      const joined: DomainEvent = {
        type: 'PARTICIPANT_JOINED',
        sessionId: session.id,
        actorId: participant.id,
        payload: { displayName: participant.displayName, role: participant.role, via: 'JOIN_REQUEST' },
      };
      return [this.event('JOIN_REQUEST_APPROVED', approved, actor.id), joined];
    });
    await this.d.bus.publishAll(events);
    return this.listPending(session, actor);
  }

  private async byToken(token: string | null) {
    if (!token || token.length < 20 || token.length > 200) throw unauthorized();
    const row = await this.d.joinRequests.touchByTokenHash(hashToken(token));
    if (!row) throw unauthorized('This join request is no longer valid');
    const session = await this.d.sessions.findById(row.sessionId);
    if (!session) throw forbidden();
    return { row, session };
  }

  private event(type: DomainEvent['type'], row: JoinRequestRow, actorId: string | null): DomainEvent {
    return {
      type,
      sessionId: row.sessionId,
      actorId,
      // names of people who are not members are for hosts (and the log) only
      payload: { requestId: row.id, displayName: row.displayName },
      publicPayload: {},
    };
  }
}
