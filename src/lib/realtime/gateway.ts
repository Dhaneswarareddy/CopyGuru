/**
 * Transport-agnostic realtime port. The Socket.IO server (server.ts) installs
 * the real implementation; tests and scripts get a no-op or recording gateway.
 * The instance lives on globalThis because Next.js bundles route handlers
 * separately from the custom server, and both must share one gateway.
 */
export interface RealtimeGateway {
  emitToSession(sessionId: string, event: string, data: unknown): void;
  emitToParticipant(participantId: string, event: string, data: unknown): void;
  onlineParticipantIds(sessionId: string): string[];
  /** Tells a participant they were removed and closes all their connections. */
  disconnectParticipant(participantId: string): void;
}

export const noopGateway: RealtimeGateway = {
  emitToSession() {},
  emitToParticipant() {},
  onlineParticipantIds: () => [],
  disconnectParticipant() {},
};

const g = globalThis as unknown as { __vqaRealtime?: RealtimeGateway };

export function setRealtimeGateway(gateway: RealtimeGateway) {
  g.__vqaRealtime = gateway;
}
export function getRealtimeGateway(): RealtimeGateway {
  return g.__vqaRealtime ?? noopGateway;
}

export const sessionRoom = (sessionId: string) => `session:${sessionId}`;
export const participantRoom = (participantId: string) => `participant:${participantId}`;

/** Event names shared by server and browser. */
export const RT = {
  SESSION_EVENT: 'session:event',
  NOTIFICATION: 'notification',
  CHAT_MESSAGE: 'chat:message',
  REMOVED: 'session:removed',
} as const;

export interface RealtimeSessionEvent {
  type: string;
  questionId: string | null;
  data: Record<string, unknown>;
  at: string;
}
