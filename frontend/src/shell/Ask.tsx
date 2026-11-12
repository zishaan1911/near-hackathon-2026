import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { chatAvailable, sendChatMessage, type ChatMessage } from '../lib/api';
import { errorLine } from '../lib/trade';
import { SPRING_UI } from '../ui/motion';

/**
 * The assistant, as a quiet button in the corner. Closed by default, and not
 * rendered at all when the server has no assistant configured.
 */
export function Ask({ hideOnPhone = false }: { hideOnPhone?: boolean }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void chatAvailable().then((ok) => {
      if (active) setAvailable(ok);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggle.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setDraft('');
    setBusy(true);
    setError('');
    try {
      const reply = await sendChatMessage(next);
      setMessages((current) => [...current, { role: 'assistant', content: reply }]);
    } catch (e) {
      if ((e as { status?: number }).status === 501) {
        setAvailable(false);
        return;
      }
      setError(errorLine(e, 'No answer right now. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;

  return (
    <div className={hideOnPhone ? 'ask ask-phone-hidden' : 'ask'}>
      <AnimatePresence>
        {open && (
          <motion.section
            className="ask-panel"
            role="dialog"
            aria-label="Ask about Silica"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={SPRING_UI}
          >
            <div className="ask-log" ref={scroller} aria-live="polite">
              {messages.length === 0 && (
                <p className="muted">Ask how Silica works, or what the index is right now.</p>
              )}
              {messages.map((message, i) => (
                <p key={i} className={`ask-msg ask-${message.role}`}>
                  <span className="sr-only">{message.role === 'user' ? 'You: ' : 'Answer: '}</span>
                  {message.content}
                </p>
              ))}
              {busy && <p className="ask-msg ask-assistant muted">Thinking…</p>}
              {error && (
                <p className="error-line" role="alert">
                  {error}
                </p>
              )}
            </div>
            <form className="ask-form" onSubmit={(event) => void submit(event)}>
              <input
                ref={input}
                className="input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask a question"
                aria-label="Your question"
                maxLength={2000}
              />
              <button type="submit" className="btn btn-sm" disabled={busy || !draft.trim()}>
                Send
              </button>
            </form>
          </motion.section>
        )}
      </AnimatePresence>
      <button
        ref={toggle}
        type="button"
        className="btn btn-outline btn-sm ask-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Close' : 'Ask'}
      </button>
    </div>
  );
}
