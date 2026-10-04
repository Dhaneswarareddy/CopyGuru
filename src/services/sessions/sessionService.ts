import crypto from 'node:crypto';
import type { AppConfig } from '@/lib/config';
import { generateSessionCode, generateToken, hashToken } from '@/lib/auth/tokens';
import type { Db } from '@/lib/database/client';
import type { ActivityRepo } from '@/lib/database/repositories/activity';
import type { SessionsRepo } from '@/lib/database/repositories/sessions';
import { SESSION_SETTINGS_SCHEMA, parseSettings } from '@/lib/domain/settings';
import type { ParticipantRow, Role, SessionRow } from '@/lib/domain/types';
import type { DashboardView, ParticipantView, SessionStateView, SessionView } from '@/lib/domain/views';
import type { EventBus } from '@/lib/events/bus';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '@/lib/http/errors';
import { Permission, authorize, can } from '@/lib/permissions/permissions';
import type { RealtimeGateway } from '@/lib/realtime/gateway';
import type { QuestionService } from '@/services/questions/questionService';
import { visibilityFor } from '@/services/questions/visibility';
import type { SubmissionService } from '@/services/submissions/submissionService';

export interface SessionDeps {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  sessions: SessionsRepo;
  activity: ActivityRepo;
  realtime: () => RealtimeGateway;
  questionService: QuestionService;
  submissionService: () => SubmissionService;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export class SessionService {
  constructor(private d: SessionDeps) {}

  cleanName(input: unknown, what: string): string {
    if (typeof input !== 'string') throw badRequest(`${what} is required`);
    const name = input.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (!name) throw badRequest(`${what} is required`);
    if (name.length > this.d.config.limits.maxNameLength)
      throw badRequest(`${what} is too long (max ${this.d.config.limits.maxNameLength} characters)`);
    return name;
  }

  async create(input: { name: unknown; hostName: unknown; settings?: unknown; isDemo?: boolean }) {
    const name = this.cleanName(input.name, 'Session name');
    const hostName = this.cleanName(input.hostName, 'Your name');
    const settings = parseSettings(input.settings);
    const token = generateToken();

    const { session, participant } = await this.d.db.tx(async () => {
      const userId = crypto.randomUUID();
      await this.d.sessions.insertUser(userId, hostName);
      let code = generateSessionCode();
      for (let i = 0; i < 5 && (await this.d.sessions.findByCode(code)); i++) code = generateSessionCode();
      const session = await this.d.sessions.insertSession({
        id: crypto.randomUUID(),
        code,
        name,
        settings,
        hostUserId: userId,
        isDemo: !!input.isDemo,
      });
      const participant = await this.d.sessions.insertParticipant({
        id: crypto.randomUUID(),
        sessionId: session.id,
        userId,
        displayName: hostName,
        role: 'HOST',
        tokenHash: hashToken(token),
      });
      return { session, participant };
    });
    await this.d.bus.publish({
      type: 'SESSION_CREATED',
      sessionId: session.id,
      actorId: participant.id,
      payload: { name, code: session.code, settings },
    });
    return { session, participant, token };
  }

  async join(codeOrId: string, input: { displayName: unknown; role?: Role; preApproved?: boolean }) {
    const displayName = this.cleanName(input.displayName, 'Your name');
    const session = await this.resolveSession(codeOrId);
    if (session.status === 'ENDED') throw conflict('This session has ended', 'SESSION_ENDED');
    // the browser turns this into an "ask to join" request (see JoinRequestService)
    if (session.settings.approveAllJoins === true && !input.preApproved)
      throw conflict('The host approves everyone who joins this session', 'APPROVAL_REQUIRED');
    const token = generateToken();
    const participant = await this.d.db.tx(async () => {
      await this.d.sessions.lockSession(session.id);
      if ((await this.d.sessions.countParticipants(session.id)) >= this.d.config.limits.maxParticipants)
        throw conflict('This session is full', 'SESSION_FULL');
      if (await this.d.sessions.nameTaken(session.id, displayName))
        throw conflict('That name is already taken in this session', 'NAME_TAKEN');
      const userId = crypto.randomUUID();
      await this.d.sessions.insertUser(userId, displayName);
      return this.d.sessions.insertParticipant({
        id: crypto.randomUUID(),
        sessionId: session.id,
        userId,
        displayName,
        role: input.role ?? 'PARTICIPANT',
        tokenHash: hashToken(token),
      });
    });
    await this.d.bus.publish({
      type: 'PARTICIPANT_JOINED',
      sessionId: session.id,
      actorId: participant.id,
      payload: { displayName, role: participant.role },
    });
    return { session, participant, token };
  }

  async start(session: SessionRow, actor: ParticipantRow) {
    authorize(actor, session, Permission.START_SESSION);
    if (session.status !== 'WAITING') throw conflict('The session has already been started', 'ALREADY_STARTED');
    const updated = await this.d.sessions.setStatus(session.id, 'ACTIVE');
    await this.d.bus.publish({ type: 'SESSION_STARTED', sessionId: session.id, actorId: actor.id, payload: {} });
    return updated;
  }

  async end(session: SessionRow, actor: ParticipantRow) {
    authorize(actor, session, Permission.END_SESSION);
    if (session.status === 'ENDED') throw conflict('The session has already ended', 'ALREADY_ENDED');
    const updated = await this.d.sessions.setStatus(session.id, 'ENDED');
    await this.d.bus.publish({ type: 'SESSION_ENDED', sessionId: session.id, actorId: actor.id, payload: {} });
    return updated;
  }

  /**
   * Removes someone from the session. They lose access immediately; what they
   * already contributed (answers, images, votes) stays on record untouched.
   */
  async removeParticipant(session: SessionRow, actor: ParticipantRow, targetId: string) {
    authorize(actor, session, Permission.REMOVE_PARTICIPANTS);
    const target = /^[0-9a-f-]{36}$/i.test(targetId) ? await this.d.sessions.findParticipant(targetId) : null;
    if (!target || target.sessionId !== session.id) throw notFound('Participant');
    if (target.id === actor.id) throw badRequest('You cannot remove yourself', 'CANNOT_REMOVE_SELF');
    if (target.role === 'HOST') throw forbidden('The host cannot be removed', 'CANNOT_REMOVE_HOST');
    if (target.removedAt) throw conflict('That person has already been removed', 'ALREADY_REMOVED');
    await this.d.sessions.markRemoved(target.id, actor.id);
    // cut their live connection first, then tell everyone else
    this.d.realtime().disconnectParticipant(target.id);
    await this.d.bus.publish({
      type: 'PARTICIPANT_REMOVED',
      sessionId: session.id,
      actorId: actor.id,
      payload: { participantId: target.id, displayName: target.displayName },
      publicPayload: {},
    });
    return this.participants(session, actor);
  }

  /** Changes settings while the session is running. Only known keys with valid values are applied. */
  async updateSettings(session: SessionRow, actor: ParticipantRow, input: unknown) {
    authorize(actor, session, Permission.MANAGE_SETTINGS);
    if (session.status === 'ENDED') throw conflict('This session has ended', 'SESSION_ENDED');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Settings must be an object');
    const before = parseSettings(session.settings) as unknown as Record<string, unknown>;
    const next = parseSettings({ ...before, ...(input as Record<string, unknown>) });
    const changed = SESSION_SETTINGS_SCHEMA.map((f) => f.key).filter(
      (k) => before[k] !== (next as unknown as Record<string, unknown>)[k],
    );
    if (!changed.length) return session;
    const updated = await this.d.sessions.updateSettings(session.id, next);
    await this.d.bus.publish({
      type: 'SESSION_SETTINGS_UPDATED',
      sessionId: session.id,
      actorId: actor.id,
      payload: { changed },
      publicPayload: {},
    });
    return updated;
  }

  /** Every answer in the session as CSV, for the host. */
  async exportCsv(session: SessionRow, viewer: ParticipantRow): Promise<string> {
    authorize(viewer, session, Permission.VIEW_DASHBOARD);
    const rows = await this.d.questionService.exportRows(session.id);
    // spreadsheet apps run cells that start with = + - @ as formulas: neutralise them
    const cell = (v: unknown) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Question', 'Question status', 'Consensus %', 'Answers on question', 'Participant', 'Answer', 'Normalized answer', 'Relationship', 'Agreed with', 'Source', 'Answered at'];
    const lines = rows.map((r) =>
      [r.number, r.status, r.consensusPct ?? '', r.answerCount, r.participant, r.rawAnswer, r.normalizedAnswer, r.relationship, r.endorsedRaw ?? '', r.source, new Date(r.createdAt).toISOString()]
        .map(cell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\r\n') + '\r\n';
  }

  /** Codes are case-insensitive; UUIDs are accepted too. */
  async resolveSession(codeOrId: string): Promise<SessionRow> {
    const ref = String(codeOrId ?? '').trim();
    const session = /^[0-9a-f-]{36}$/i.test(ref)
      ? await this.d.sessions.findById(ref)
      : /^[A-Za-z0-9]{4,12}$/.test(ref)
        ? await this.d.sessions.findByCode(ref.toUpperCase())
        : null;
    if (!session) throw notFound('Session');
    return session;
  }

  /** Resolves a bearer token to its participant + session. */
  async authenticate(token: string | null | undefined): Promise<{ session: SessionRow; participant: ParticipantRow }> {
    if (!token || token.length < 20 || token.length > 200) throw unauthorized();
    const participant = await this.d.sessions.findParticipantByTokenHash(hashToken(token));
    if (!participant) throw unauthorized('Your session access is no longer valid');
    if (participant.removedAt) throw forbidden('The host removed you from this session', 'REMOVED');
    const session = await this.d.sessions.findById(participant.sessionId);
    if (!session) throw unauthorized();
    return { session, participant };
  }

  toSessionView(s: SessionRow): SessionView {
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      status: s.status,
      settings: parseSettings(s.settings),
      isDemo: s.isDemo,
      createdAt: iso(s.createdAt)!,
      startedAt: iso(s.startedAt),
      endedAt: iso(s.endedAt),
    };
  }

  async participants(session: SessionRow, viewer: ParticipantRow): Promise<ParticipantView[]> {
    const online = new Set(this.d.realtime().onlineParticipantIds(session.id));
    const current = (await this.d.sessions.listParticipants(session.id)).filter((p) => !p.removedAt);
    return current.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      role: p.role,
      online: online.has(p.id),
      isMe: p.id === viewer.id,
    }));
  }

  async state(session: SessionRow, viewer: ParticipantRow): Promise<SessionStateView> {
    const participants = await this.participants(session, viewer);
    const active = session.status === 'ACTIVE';
    return {
      session: this.toSessionView(session),
      me: participants.find((p) => p.isMe)!,
      participants,
      caps: {
        canStart: session.status === 'WAITING' && can(viewer, session, Permission.START_SESSION),
        canEnd: session.status !== 'ENDED' && can(viewer, session, Permission.END_SESSION),
        canPost: active && can(viewer, session, Permission.POST_ANSWER),
        canChallenge: active && can(viewer, session, Permission.CHALLENGE_ANSWER),
        canResolve: can(viewer, session, Permission.RESOLVE_CHALLENGE),
        canViewDashboard: can(viewer, session, Permission.VIEW_DASHBOARD),
        canAdmit: session.status !== 'ENDED' && can(viewer, session, Permission.ADMIT_PARTICIPANTS),
        canRemoveParticipants: can(viewer, session, Permission.REMOVE_PARTICIPANTS),
        canManageSettings: session.status !== 'ENDED' && can(viewer, session, Permission.MANAGE_SETTINGS),
        canSeeConsensus: visibilityFor(session, viewer, false).consensus,
      },
      unreadNotifications: await this.d.activity.unreadCount(viewer.id),
      pending: active ? await this.d.submissionService().pendingFor(session, viewer) : null,
      limits: {
        maxImageBytes: this.d.config.images.maxBytes,
        maxAnswerLength: this.d.config.limits.maxAnswerLength,
      },
    };
  }

  async dashboard(session: SessionRow, viewer: ParticipantRow): Promise<DashboardView> {
    authorize(viewer, session, Permission.VIEW_DASHBOARD);
    const [stats, list, events, participantRows] = await Promise.all([
      this.d.sessions.stats(session.id),
      this.d.questionService.list(session, viewer, { sort: 'NEWEST', limit: 100 }),
      this.d.activity.listSessionEvents(session.id, 80),
      this.d.sessions.listParticipants(session.id),
    ]);
    const participants = new Map(participantRows.map((p) => [p.id, p]));
    return {
      stats: { ...stats, online: this.d.realtime().onlineParticipantIds(session.id).length },
      questions: [...list.items].sort((a, b) => a.number - b.number),
      events: events.map((e) => this.d.questionService.toHistory(e, participants)),
    };
  }
}
