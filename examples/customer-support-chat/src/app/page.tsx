'use client';

import { FormEvent, useMemo, useState } from 'react';
import type { SupportChatMessage } from '@/lib/support-agent';

interface ChatResponse {
  status: 'done' | 'suspended';
  messages: SupportChatMessage[];
}

function createConversationId() {
  return globalThis.crypto?.randomUUID?.() ?? `support-${Date.now()}`;
}

export default function Page() {
  const [conversationId] = useState(createConversationId);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<SupportChatMessage[]>([]);
  const [status, setStatus] = useState<ChatResponse['status']>('done');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const visibleMessages = useMemo(
    () => messages.filter((item) => item.content.trim().length > 0),
    [messages],
  );

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextMessage = message.trim();
    if (!nextMessage || isSending) {
      return;
    }

    setIsSending(true);
    setError(undefined);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message: nextMessage }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? 'The support runtime failed.');
      }

      const payload = (await response.json()) as ChatResponse;
      // The client renders the server-returned transcript instead of appending locally.
      setMessages(payload.messages);
      setStatus(payload.status);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected chat error.');
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="shell">
      <section className="conversation-panel" aria-label="Support chat">
        <header className="topbar">
          <div>
            <p className="eyebrow">Trail Supply Support</p>
            <h1>Customer chat</h1>
          </div>
          <div className="run-pill" title={conversationId}>
            <span>Status: {status}</span>
            <code>{conversationId.slice(0, 8)}</code>
          </div>
        </header>

        <div className="message-list" aria-live="polite">
          {visibleMessages.length === 0 ? (
            <div className="empty-state">
              <p>Ask about order ORD-1001, ORD-1002, or ORD-1003.</p>
            </div>
          ) : (
            visibleMessages.map((item, index) => (
              <article
                className={`message-row ${item.type}`}
                key={`${item.type}-${index}-${item.content.slice(0, 16)}`}
              >
                <div className="message-meta">
                  {item.type === 'tool_result' ? 'tool result' : item.type}
                </div>
                <div className="message-bubble">{item.content}</div>
              </article>
            ))
          )}
        </div>

        {error ? <p className="error-banner">{error}</p> : null}

        <form className="composer" onSubmit={sendMessage}>
          <label className="sr-only" htmlFor="support-message">
            Message
          </label>
          <input
            id="support-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Example: Where is order ORD-1001?"
            disabled={isSending}
          />
          <button type="submit" disabled={isSending || !message.trim()}>
            {isSending ? 'Sending' : 'Send'}
          </button>
        </form>
      </section>
    </main>
  );
}
