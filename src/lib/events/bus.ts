import type { DomainEvent, DomainEventType, EventHandler } from './types';

/**
 * In-process publish/subscribe. Handlers run sequentially and are isolated: a
 * failing subscriber is logged and never breaks the operation that published
 * the event. Swap for Redis streams / a queue when running multiple instances.
 */
export class EventBus {
  private handlers = new Map<DomainEventType | '*', Set<EventHandler>>();

  subscribe(type: DomainEventType | DomainEventType[] | '*', handler: EventHandler): () => void {
    const types = Array.isArray(type) ? type : [type];
    for (const t of types) {
      if (!this.handlers.has(t)) this.handlers.set(t, new Set());
      this.handlers.get(t)!.add(handler);
    }
    return () => types.forEach((t) => this.handlers.get(t)?.delete(handler));
  }

  async publish(event: DomainEvent): Promise<void> {
    event.at ??= new Date();
    const targets = [...(this.handlers.get('*') ?? []), ...(this.handlers.get(event.type) ?? [])];
    for (const handler of targets) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[events] subscriber failed for ${event.type}:`, err);
      }
    }
  }

  async publishAll(events: DomainEvent[]): Promise<void> {
    for (const e of events) await this.publish(e);
  }
}
