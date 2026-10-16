// UI-16: chat with the team's MCP servers. The browser only talks to POST /api/chat; the gateway runs
// the agent and makes every tool call through its own /mcp under this user's name (UI-14/15), so the
// calls are authorized and audited like any MCP client's. Each answer lists the tool calls behind it.
// Replies are drawn as text nodes with a small Markdown subset (chat.ts replyLines), never as HTML:
// model output is untrusted.
import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ToolCall } from '../api.js';
import { useMe } from '../auth.js';
import { chatStore, formatArgs, formatResult, MAX_CONTENT, replyLines, toolLabel, useChat, type Turn } from '../chat.js';

const SUGGESTIONS = [
  'What orders came in today?',
  'List 5 products with their prices and stock.',
  'Which MCP servers and tools can you use?',
];

export function Chat() {
  const me = useMe().data!;
  chatStore.bind(me.id);
  const chat = useChat();
  const pending = chat.pendingSince !== null;
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [chat.turns.length, pending]);
  useEffect(() => {
    if (!pending) inputRef.current?.focus();
  }, [pending]);

  const send = (text = chat.draft) => void chatStore.send(text);
  const submit = (e: FormEvent) => { e.preventDefault(); send(); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  return (
    <section className="chat">
      <div className="row between">
        <div>
          <h1>Chat</h1>
          <p className="muted small">
            Ask about the store or any connected server. The agent calls MCP tools through the gateway as you, and
            every call is in the audit log.
          </p>
        </div>
        {chat.turns.length > 0 && (
          <button type="button" className="ghost" onClick={() => chatStore.reset()} disabled={pending}>New chat</button>
        )}
      </div>

      <div className="transcript" aria-live="polite" aria-busy={pending}>
        {chat.turns.length === 0 && !pending && (
          <div className="card empty">
            <p className="muted">Try one of these:</p>
            <div className="row wrap">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="ghost" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {chat.turns.map((t) => (t.role === 'user' ? <UserTurn key={t.id} turn={t} /> : <AnswerTurn key={t.id} turn={t} />))}
        {pending && <Thinking since={chat.pendingSince!} />}
        <div ref={endRef} className="transcript-end" />
      </div>

      {chat.error && <p className="error" role="alert">{chat.error.message}</p>}
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-input">Message</label>
        <textarea id="chat-input" ref={inputRef} rows={2} maxLength={MAX_CONTENT} value={chat.draft}
          placeholder="Ask something… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => chatStore.setDraft(e.target.value)} onKeyDown={onKey} />
        <button type="submit" disabled={pending || chat.draft.trim() === ''}>{pending ? 'Working…' : 'Send'}</button>
      </form>
    </section>
  );
}

function UserTurn({ turn }: { turn: Turn }) {
  return (
    <div className="turn user">
      <div className="bubble">{turn.content}</div>
    </div>
  );
}

function AnswerTurn({ turn }: { turn: Turn }) {
  const calls = turn.toolCalls ?? [];
  const failed = calls.filter((c) => !c.ok).length;
  return (
    <div className="turn assistant">
      {calls.length > 0 && (
        <div className="calls">
          <p className="small muted">
            {calls.length} tool call{calls.length === 1 ? '' : 's'}{failed > 0 ? `, ${failed} failed` : ''}
          </p>
          {calls.map((c, i) => <ToolCallCard key={i} call={c} />)}
        </div>
      )}
      {calls.length === 0 && <p className="small muted">No tools were used for this answer.</p>}
      {turn.stopped && turn.stopped !== 'answer' && (
        <p className="small warn">{turn.stopped === 'deadline' ? 'Stopped: time limit reached.' : 'Stopped: too many tool rounds.'}</p>
      )}
      <div className="bubble"><ReplyText text={turn.content} /></div>
    </div>
  );
}

function ReplyText({ text }: { text: string }) {
  return replyLines(text).map((line, i) => (
    <Fragment key={i}>
      {i > 0 && '\n'}
      {line.map((s, j) => (s.style === 'bold' ? <strong key={j}>{s.text}</strong> : s.style === 'code' ? <code key={j}>{s.text}</code> : s.text))}
    </Fragment>
  ));
}

function ToolCallCard({ call }: { call: ToolCall }) {
  const args = formatArgs(call.args);
  return (
    <details className={`toolcall ${call.ok ? 'ok' : 'failed'}`}>
      <summary>
        <span className={`outcome ${call.ok ? 'ok' : 'error'}`}>{call.ok ? 'ok' : 'error'}</span>
        <code className="tool-name">{toolLabel(call)}</code>
        <span className="muted small">{call.server ?? 'agent'}</span>
        <span className="muted small ms">{call.ms} ms</span>
      </summary>
      <div className="toolcall-body">
        <div>
          <div className="small muted">Server / tool</div>
          <code>{call.name}</code>
        </div>
        <div>
          <div className="small muted">Arguments</div>
          {args ? <pre>{args}</pre> : <p className="small muted">none</p>}
        </div>
        <div>
          <div className="small muted">{call.ok ? 'Result' : 'Error'} (excerpt)</div>
          <pre>{formatResult(call.resultPreview) || '(empty)'}</pre>
        </div>
      </div>
    </details>
  );
}

function Thinking({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="turn assistant" role="status">
      <p className="muted small thinking">Working on it… {Math.max(0, Math.round((now - since) / 1000))} s (calling tools can take a while)</p>
    </div>
  );
}
