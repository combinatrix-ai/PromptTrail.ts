'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { SupportAgentName, SupportChatMessage } from '@/lib/support-agent';

interface ChatResponse {
  status: 'done' | 'suspended';
  awaiting?: string;
  messages: SupportChatMessage[];
}

interface ChoiceDirective {
  reply: string;
  choices: Array<{ id: string; label: string }>;
}

interface UsersResponse {
  users: string[];
}

function sanitizeUserName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function conversationIdFor(agent: SupportAgentName, userName: string) {
  return `${agent}:${userName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function choiceDirective(value: unknown): ChoiceDirective | undefined {
  if (!isRecord(value) || typeof value.reply !== 'string') {
    return undefined;
  }
  if (!Array.isArray(value.choices)) {
    return undefined;
  }

  const choices = value.choices.filter(
    (choice): choice is { id: string; label: string } =>
      isRecord(choice) &&
      typeof choice.id === 'string' &&
      typeof choice.label === 'string',
  );

  return { reply: value.reply, choices };
}

function messageContent(item: SupportChatMessage) {
  if (item.type === 'tool_result') {
    return `tool: ${item.content.slice(0, 80)}`;
  }

  if (item.structuredContent !== undefined) {
    const directive = choiceDirective(item.structuredContent);
    if (directive) {
      return directive.reply;
    }

    if (isRecord(item.structuredContent)) {
      const reply = item.structuredContent.reply;
      if (typeof reply === 'string') {
        return reply;
      }
    }
  }

  return item.content;
}

function lastAssistantMessage(messages: SupportChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.type === 'assistant') {
      return message;
    }
  }
  return undefined;
}

export default function Page() {
  const [mode, setMode] = useState<SupportAgentName>('support');
  const [activeUser, setActiveUser] = useState<string | undefined>();
  const [nameEntry, setNameEntry] = useState('');
  const [savedUsers, setSavedUsers] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [messagesByMode, setMessagesByMode] = useState<
    Record<SupportAgentName, SupportChatMessage[]>
  >({ support: [], returns: [] });
  const [statusByMode, setStatusByMode] = useState<
    Record<SupportAgentName, ChatResponse['status']>
  >({ support: 'done', returns: 'done' });
  const [awaitingByMode, setAwaitingByMode] = useState<
    Record<SupportAgentName, string | undefined>
  >({ support: undefined, returns: undefined });
  const [isSending, setIsSending] = useState(false);
  const [isLoadingUser, setIsLoadingUser] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const conversationIds = useMemo(
    () =>
      activeUser
        ? {
            support: conversationIdFor('support', activeUser),
            returns: conversationIdFor('returns', activeUser),
          }
        : undefined,
    [activeUser],
  );
  const conversationId = conversationIds?.[mode] ?? '';
  const messages = messagesByMode[mode];
  const status = statusByMode[mode];
  const awaiting = awaitingByMode[mode];

  useEffect(() => {
    void refreshSavedUsers();
  }, []);

  const visibleMessages = useMemo(
    () => messages.filter((item) => messageContent(item).trim().length > 0),
    [messages],
  );

  const pendingChoice = useMemo(() => {
    if (status !== 'suspended') {
      return undefined;
    }
    const lastAssistant = lastAssistantMessage(messages);
    return choiceDirective(lastAssistant?.structuredContent);
  }, [messages, status]);

  async function sendText(nextMessage: string) {
    if (!nextMessage || isSending || !conversationIds) {
      return;
    }

    const activeMode = mode;
    setIsSending(true);
    setError(undefined);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversationIds[activeMode],
          message: nextMessage,
          agent: activeMode,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? 'The support runtime failed.');
      }

      const payload = (await response.json()) as ChatResponse;
      // The client renders the server-returned transcript instead of appending locally.
      setMessagesByMode((current) => ({
        ...current,
        [activeMode]: payload.messages,
      }));
      setStatusByMode((current) => ({
        ...current,
        [activeMode]: payload.status,
      }));
      setAwaitingByMode((current) => ({
        ...current,
        [activeMode]: payload.awaiting,
      }));
      setMessage('');
      await refreshSavedUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected chat error.');
    } finally {
      setIsSending(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendText(message.trim());
  }

  async function refreshSavedUsers() {
    const response = await fetch('/api/users');
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as UsersResponse;
    setSavedUsers(payload.users);
  }

  async function loadUser(userName: string) {
    const sanitized = sanitizeUserName(userName);
    if (!sanitized || isLoadingUser) {
      return;
    }

    setIsLoadingUser(true);
    setError(undefined);

    try {
      const [supportResponse, returnsResponse] = await Promise.all([
        fetch(
          `/api/conversation?conversationId=${encodeURIComponent(
            conversationIdFor('support', sanitized),
          )}`,
        ),
        fetch(
          `/api/conversation?conversationId=${encodeURIComponent(
            conversationIdFor('returns', sanitized),
          )}`,
        ),
      ]);

      if (!supportResponse.ok || !returnsResponse.ok) {
        throw new Error('Could not load saved conversations.');
      }

      const [supportPayload, returnsPayload] = (await Promise.all([
        supportResponse.json(),
        returnsResponse.json(),
      ])) as [ChatResponse, ChatResponse];

      setActiveUser(sanitized);
      setNameEntry('');
      setMessagesByMode({
        support: supportPayload.messages,
        returns: returnsPayload.messages,
      });
      setStatusByMode({
        support: supportPayload.status,
        returns: returnsPayload.status,
      });
      setAwaitingByMode({
        support: supportPayload.awaiting,
        returns: returnsPayload.awaiting,
      });
      await refreshSavedUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected load error.');
    } finally {
      setIsLoadingUser(false);
    }
  }

  async function startUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadUser(nameEntry);
  }

  if (!activeUser) {
    return (
      <main className="shell">
        <section className="landing-panel" aria-label="Choose support user">
          <div>
            <p className="eyebrow">Trail Supply Support</p>
            <h1>Choose a customer</h1>
          </div>

          <form className="name-form" onSubmit={startUser}>
            <label htmlFor="customer-name">Customer name</label>
            <div className="name-entry">
              <input
                id="customer-name"
                value={nameEntry}
                onChange={(event) => setNameEntry(event.target.value)}
                placeholder="Example: Mina Tanaka"
                disabled={isLoadingUser}
              />
              <button
                type="submit"
                disabled={isLoadingUser || !sanitizeUserName(nameEntry)}
              >
                {isLoadingUser ? 'Loading' : 'Continue'}
              </button>
            </div>
          </form>

          {savedUsers.length > 0 ? (
            <div className="saved-users" aria-label="Saved users">
              {savedUsers.map((user) => (
                <button
                  type="button"
                  key={user}
                  disabled={isLoadingUser}
                  onClick={() => loadUser(user)}
                >
                  {user}
                </button>
              ))}
            </div>
          ) : null}

          {error ? <p className="error-banner">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="conversation-panel" aria-label="Support chat">
        <header className="topbar">
          <div>
            <p className="eyebrow">Trail Supply Support</p>
            <h1>Customer chat</h1>
          </div>
          <div className="topbar-actions">
            <div className="mode-toggle" aria-label="Conversation mode">
              <button
                type="button"
                aria-pressed={mode === 'support'}
                onClick={() => setMode('support')}
              >
                Support chat
              </button>
              <button
                type="button"
                aria-pressed={mode === 'returns'}
                onClick={() => setMode('returns')}
              >
                Return wizard
              </button>
            </div>
            <div className="run-pill" title={conversationId}>
              <span>User: {activeUser}</span>
              <span>Status: {status}</span>
              {awaiting ? <span>Awaiting: {awaiting}</span> : null}
              <code>{conversationId}</code>
              <button type="button" onClick={() => setActiveUser(undefined)}>
                Switch user
              </button>
            </div>
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
                  {item.type === 'tool_result' ? 'tool' : item.type}
                </div>
                <div className="message-bubble">{messageContent(item)}</div>
              </article>
            ))
          )}
        </div>

        {pendingChoice ? (
          <div className="choice-panel">
            <p>{pendingChoice.reply}</p>
            <div className="choice-list">
              {pendingChoice.choices.map((choice) => (
                <button
                  type="button"
                  key={choice.id}
                  disabled={isSending}
                  onClick={() => sendText(choice.id)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {error ? <p className="error-banner">{error}</p> : null}

        <form className="composer" onSubmit={sendMessage}>
          <label className="sr-only" htmlFor="support-message">
            Message
          </label>
          <input
            id="support-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={
              mode === 'returns'
                ? 'Example: I need to return an order'
                : 'Example: Where is order ORD-1001?'
            }
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
