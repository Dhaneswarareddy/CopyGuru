'use client';
import { useChat } from './ChatProvider';

/** Header button: opens the chat panel and shows how many messages are unread. */
export function ChatButton() {
  const { enabled, open, totalUnread, show, hide } = useChat();
  if (!enabled) return null;
  return (
    <button
      type="button"
      onClick={() => (open ? hide() : show())}
      aria-label={`Chat${totalUnread ? `, ${totalUnread} unread` : ''}`}
      aria-expanded={open}
      className={`relative rounded-lg p-2 text-lg leading-none hover:bg-slate-100 ${open ? 'bg-slate-100' : ''}`}
    >
      💬
      {totalUnread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-rose-600 px-1 text-center text-xs font-semibold leading-5 text-onaccent">
          {totalUnread > 99 ? '99+' : totalUnread}
        </span>
      )}
    </button>
  );
}
