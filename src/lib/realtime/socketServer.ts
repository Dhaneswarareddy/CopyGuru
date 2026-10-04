import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { getContainer } from '@/lib/container';
import {
  RT,
  participantRoom,
  sessionRoom,
  setRealtimeGateway,
  type RealtimeGateway,
  type RealtimeSessionEvent,
} from './gateway';

/**
 * Socket.IO transport. Sockets authenticate with the same bearer token as the
 * REST API and are placed in two rooms: their session and their own
 * participant room (for private notifications).
 */
export function attachRealtime(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 64 * 1024, // clients only ever send tiny control frames
  });

  // sessionId → participantId → open socket count
  const presence = new Map<string, Map<string, number>>();
  const presenceChanged = (sessionId: string) => {
    const message: RealtimeSessionEvent = {
      type: 'PRESENCE_CHANGED',
      questionId: null,
      data: {},
      at: new Date().toISOString(),
    };
    io.to(sessionRoom(sessionId)).emit(RT.SESSION_EVENT, message);
  };

  const gateway: RealtimeGateway = {
    emitToSession: (sessionId, event, data) => void io.to(sessionRoom(sessionId)).emit(event, data),
    emitToParticipant: (participantId, event, data) => void io.to(participantRoom(participantId)).emit(event, data),
    onlineParticipantIds: (sessionId) => [...(presence.get(sessionId)?.keys() ?? [])],
    disconnectParticipant: (participantId) => {
      io.to(participantRoom(participantId)).emit(RT.REMOVED, {});
      io.in(participantRoom(participantId)).disconnectSockets(true);
    },
  };
  setRealtimeGateway(gateway);

  io.use(async (socket, next) => {
    try {
      const container = await getContainer();
      const { session, participant } = await container.sessions.authenticate(socket.handshake.auth?.token);
      socket.data.sessionId = session.id;
      socket.data.participantId = participant.id;
      next();
    } catch (err) {
      next(new Error((err as { code?: string })?.code === 'REMOVED' ? 'removed' : 'unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { sessionId, participantId } = socket.data as { sessionId: string; participantId: string };
    socket.join([sessionRoom(sessionId), participantRoom(participantId)]);

    const members = presence.get(sessionId) ?? new Map<string, number>();
    presence.set(sessionId, members);
    members.set(participantId, (members.get(participantId) ?? 0) + 1);
    if (members.get(participantId) === 1) presenceChanged(sessionId);

    socket.on('disconnect', () => {
      const left = (members.get(participantId) ?? 1) - 1;
      if (left <= 0) {
        members.delete(participantId);
        if (!members.size) presence.delete(sessionId);
        presenceChanged(sessionId);
      } else members.set(participantId, left);
    });
  });

  return io;
}
