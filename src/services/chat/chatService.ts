import type { ChatMessageRow, ChatRepo } from '@/lib/database/repositories/chat';
import type { SessionsRepo } from '@/lib/database/repositories/sessions';
import type { ParticipantRow, SessionRow } from '@/lib/domain/types';
import type { ChatMessageView, ChatOverviewView, ChatThreadView } from '@/lib/domain/views';
import { badRequest, conflict, forbidden, notFound } from '@/lib/http/errors';
import { Permission, authorize, can } from '@/lib/permissions/permissions';
import { RT, type RealtimeGateway } from '@/lib/realtime/gateway';

export interface ChatDeps {
  sessions: SessionsRepo;
  chat: ChatRepo;
  realtime: () => RealtimeGateway;
}

export const PUBLIC_CHANNEL = 'public';
export const MAX_CHAT_LENGTH = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session chat: one public channel ("Everyone") and private one-to-one
 * conversations. A private message is delivered to, and readable by, exactly
 * its two participants — not the host, not the event log.
 *
 * Chat deliberately does not go through the domain EventBus: that bus is
 * logged for the host and broadcast to the whole session, which private
 * messages must never be.
 */
export class ChatService {
  constructor(private d: ChatDeps) {}

  private privateAllowed(session: SessionRow) {
    return session.settings.privateChatEnabled !== false;
  }

  toView(m: ChatMessageRow): ChatMessageView {
    return {
      id: m.id,
      senderId: m.senderId,
      senderName: m.senderName,
      recipientId: m.recipientId,
      text: m.body,
      createdAt: new Date(m.createdAt).toISOString(),
    };
  }

  /** Resolves "public" or a participant id into a validated channel. */
  private async resolveChannel(session: SessionRow, viewer: ParticipantRow, channel: unknown): Promise<string | null> {
    if (channel === PUBLIC_CHANNEL || channel === undefined || channel === null) return null;
    if (typeof channel !== 'string' || !UUID.test(channel)) throw badRequest('Unknown chat channel');
    if (!this.privateAllowed(session)) throw forbidden('Private messages are turned off in this session', 'PRIVATE_CHAT_DISABLED');
    if (channel === viewer.id) throw badRequest('You cannot message yourself');
    const peer = await this.d.sessions.findParticipant(channel);
    // someone from another session looks exactly like someone who does not exist
    if (!peer || peer.sessionId !== session.id || peer.removedAt) throw notFound('Participant');
    return peer.id;
  }

  async overview(session: SessionRow, viewer: ParticipantRow): Promise<ChatOverviewView> {
    const enabled = can(viewer, session, Permission.USE_CHAT);
    const privateEnabled = enabled && this.privateAllowed(session);
    if (!enabled) return { enabled, privateEnabled, canSend: false, publicUnread: 0, direct: [] };
    const [publicUnread, direct] = await Promise.all([
      this.d.chat.publicUnread(session.id, viewer.id),
      privateEnabled ? this.d.chat.directOverview(session.id, viewer.id) : Promise.resolve([]),
    ]);
    return { enabled, privateEnabled, canSend: session.status !== 'ENDED', publicUnread, direct };
  }

  async messages(
    session: SessionRow,
    viewer: ParticipantRow,
    opts: { channel?: unknown; before?: string | null; limit?: number },
  ): Promise<ChatThreadView> {
    authorize(viewer, session, Permission.USE_CHAT);
    const peer = await this.resolveChannel(session, viewer, opts.channel);
    const before = opts.before && /^\d{1,18}$/.test(opts.before) ? opts.before : null;
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
    const rows = peer
      ? await this.d.chat.listDirect(session.id, viewer.id, peer, before, limit + 1)
      : await this.d.chat.listPublic(session.id, before, limit + 1);
    return { items: rows.slice(0, limit).reverse().map((r) => this.toView(r)), hasMore: rows.length > limit };
  }

  async send(session: SessionRow, sender: ParticipantRow, input: { to?: unknown; text?: unknown }): Promise<ChatMessageView> {
    authorize(sender, session, Permission.USE_CHAT);
    if (session.status === 'ENDED') throw conflict('This session has ended, so chat is closed', 'SESSION_ENDED');
    if (typeof input.text !== 'string') throw badRequest('A message is required', 'MESSAGE_REQUIRED');
    const body = input.text.replace(/\u0000/g, '').trim();
    if (!body) throw badRequest('A message is required', 'MESSAGE_REQUIRED');
    if (body.length > MAX_CHAT_LENGTH) throw badRequest(`Message is too long (max ${MAX_CHAT_LENGTH} characters)`, 'MESSAGE_TOO_LONG');
    const recipientId = await this.resolveChannel(session, sender, input.to);

    const row = await this.d.chat.insert({ sessionId: session.id, senderId: sender.id, recipientId, body });
    // the sender has, by definition, read up to their own message
    await this.d.chat.markRead(sender.id, recipientId ?? PUBLIC_CHANNEL, row.id);
    const view = this.toView(row);

    const realtime = this.d.realtime();
    if (recipientId) {
      // private: only the two people involved ever receive it
      realtime.emitToParticipant(recipientId, RT.CHAT_MESSAGE, view);
      realtime.emitToParticipant(sender.id, RT.CHAT_MESSAGE, view);
    } else {
      realtime.emitToSession(session.id, RT.CHAT_MESSAGE, view);
    }
    return view;
  }

  async markRead(session: SessionRow, viewer: ParticipantRow, input: { channel?: unknown; lastId?: unknown }) {
    authorize(viewer, session, Permission.USE_CHAT);
    const peer = await this.resolveChannel(session, viewer, input.channel);
    if (typeof input.lastId !== 'string' || !/^\d{1,18}$/.test(input.lastId)) throw badRequest('lastId is required');
    await this.d.chat.markRead(viewer.id, peer ?? PUBLIC_CHANNEL, input.lastId);
    return this.overview(session, viewer);
  }
}
