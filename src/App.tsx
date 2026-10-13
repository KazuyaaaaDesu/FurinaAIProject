
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
};

type ConversationStore = {
  version: 1;
  conversations: Conversation[];
};

const MODEL = "qwen2.5-coder:3b";
const STORAGE_KEY = "sakura-companion-chat-v1";
const STORAGE_API = "http://127.0.0.1:4317/api/conversations";
const CONVERSATION_ID = "sakura-main";

const greeting: Message = {
  role: "assistant",
  content:
    "Hey! I'm Sakura 🌸 Your local AI companion. I'm running on your own PC, so let's chat. What are you working on today?",
};

function isValidMessages(value: unknown): value is Message[] {
  return (
    Array.isArray(value) &&
    value.every(
      (message) =>
        message &&
        typeof message === "object" &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string",
    )
  );
}

function loadLegacyMessages(): Message[] | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);

    if (!saved) return null;

    const parsed: unknown = JSON.parse(saved);
    return isValidMessages(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readStore(): Promise<ConversationStore> {
  const response = await fetch(STORAGE_API);

  if (!response.ok) {
    throw new Error(`Storage server returned HTTP ${response.status}.`);
  }

  const store: unknown = await response.json();

  if (
    !store ||
    typeof store !== "object" ||
    !("version" in store) ||
    store.version !== 1 ||
    !("conversations" in store) ||
    !Array.isArray(store.conversations)
  ) {
    throw new Error("The conversation storage file has an invalid format.");
  }

  return store as ConversationStore;
}

async function saveMessages(messages: Message[]): Promise<void> {
  const store = await readStore();
  const existing = store.conversations.find(
    (conversation) => conversation.id === CONVERSATION_ID,
  );

  const updated: Conversation = {
    id: CONVERSATION_ID,
    title: "Sakura Chat",
    messages,
    updatedAt: new Date().toISOString(),
  };

  const nextStore: ConversationStore = {
    version: 1,
    conversations: [
      updated,
      ...store.conversations.filter(
        (conversation) => conversation.id !== CONVERSATION_ID,
      ),
    ],
  };

  // Do not overwrite a newer conversation with an older state.
  if (
    existing &&
    existing.updatedAt > updated.updatedAt
  ) {
    return;
  }

  const response = await fetch(STORAGE_API, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextStore),
  });

  if (!response.ok) {
    throw new Error(`Could not save conversations (HTTP ${response.status}).`);
  }
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([greeting]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [storageStatus, setStorageStatus] = useState("Loading local storage...");
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([greeting]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(false);

  const updateMessages = useCallback((next: Message[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  // Load JSON storage first. Migrate browser history only when no saved
  // conversation exists on D:. Keep the original localStorage untouched.
  useEffect(() => {
    let cancelled = false;

    async function initializeStorage() {
      try {
        const store = await readStore();

        if (cancelled) return;

        const saved = store.conversations.find(
          (conversation) => conversation.id === CONVERSATION_ID,
        );

        if (saved && isValidMessages(saved.messages)) {
          updateMessages(saved.messages);
          setStorageStatus("Saved locally on D:");
        } else if (store.conversations.length > 0) {
          // Don't replace unrelated saved conversations with browser history.
          updateMessages([greeting]);
          setStorageStatus("Ready · local JSON storage");
        } else {
          const legacy = loadLegacyMessages();
          const initial = legacy?.length ? legacy : [greeting];

          updateMessages(initial);
          setStorageStatus("Migrating browser history...");

          await saveMessages(initial);

          if (cancelled) return;
          setStorageStatus("Saved locally on D:");
        }

        if (!cancelled) setStorageReady(true);
      } catch (err) {
        if (cancelled) return;

        const message =
          err instanceof Error ? err.message : "Unknown storage error.";

        setError(
          `Local storage unavailable: ${message} Start the Sakura storage server before chatting.`,
        );
        setStorageStatus("Storage offline");
      }
    }

    void initializeStorage();

    return () => {
      cancelled = true;
    };
  }, [updateMessages]);

  // Save message changes to JSON. Serialize writes to avoid overlapping saves.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });

    if (!storageReady || !mountedRef.current) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      const snapshot = messages;
      saveQueueRef.current = saveQueueRef.current
        .catch(() => {})
        .then(() => saveMessages(snapshot))
        .then(() => {
          setStorageStatus("Saved locally on D:");
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Unknown storage error.";

          setStorageStatus("Save failed");
          setError(`Could not save your conversation: ${message}`);
        });
    }, 300);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [messages, storageReady]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  async function sendMessage() {
    const text = input.trim();

    if (!text || busy || !storageReady) return;

    const conversation = [
      ...messagesRef.current,
      { role: "user" as const, content: text },
    ];

    updateMessages(conversation);
    setInput("");
    setError("");
    setBusy(true);

    const history = conversation
      .filter(
        (_, index) =>
          !(index === 0 && conversation[index].role === "assistant"),
      )
      .slice(-20)
      .map(({ role, content }) => ({ role, content }));

    try {
      const response = await fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are Sakura, a friendly, thoughtful desktop AI companion. " +
                "Be warm, natural, helpful, and conversational. You run locally on the user's PC. " +
                "Do not claim to see their screen or know things they have not shared.",
            },
            ...history,
          ],
          stream: true,
          keep_alive: "30m",
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}.`);
      }

      if (!response.body) {
        throw new Error("The response stream was unavailable.");
      }

      updateMessages([
        ...conversation,
        { role: "assistant", content: "" },
      ]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamFailed = false;

      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          const data = JSON.parse(line) as {
            message?: { content?: string };
            error?: string;
            done?: boolean;
          };

          if (data.error) throw new Error(data.error);

          const chunk = data.message?.content ?? "";

          if (chunk) {
            messagesRef.current = [
              ...messagesRef.current.slice(0, -1),
              {
                ...messagesRef.current[messagesRef.current.length - 1],
                content:
                  (messagesRef.current[messagesRef.current.length - 1]
                    ?.content ?? "") + chunk,
              },
            ];

            setMessages(messagesRef.current);
          }

          if (data.done) streamFailed = false;
        }
      }

      // Process any final JSON record left in the stream buffer.
      if (buffer.trim()) {
        const data = JSON.parse(buffer) as {
          message?: { content?: string };
          error?: string;
        };

        if (data.error) throw new Error(data.error);

        const chunk = data.message?.content ?? "";

        if (chunk) {
          const current = messagesRef.current;
          const last = current[current.length - 1];

          if (last?.role === "assistant") {
            updateMessages([
              ...current.slice(0, -1),
              { ...last, content: last.content + chunk },
            ]);
          }
        }
      }

      void streamFailed;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong.";

      setError(
        `${message} Check that Ollama is running and the model is available.`,
      );

      const current = messagesRef.current;
      const last = current[current.length - 1];

      if (last?.role === "assistant" && !last.content) {
        updateMessages(current.slice(0, -1));
      }
    } finally {
      setBusy(false);
    }
  }

  function clearChat() {
    if (busy || !storageReady) return;

    updateMessages([greeting]);
    setError("");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">桜</div>
          <div>
            <h1>Sakura</h1>
            <span>LOCAL COMPANION</span>
          </div>
        </div>

        <div className="sidebar-label">WORKSPACE</div>

        <button className="nav-item active" disabled={!storageReady}>
          <span>✿</span> Companion chat
        </button>

        <button
          className="nav-item"
          onClick={clearChat}
          disabled={busy || !storageReady}
        >
          <span>↻</span> New conversation
        </button>

        <div className="sidebar-bottom">
          <div className="connection-dot" />
          <div>
            <strong>Local mode</strong>
            <p>Your PC, your models.</p>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">YOUR PERSONAL SPACE</span>
            <h2>Companion</h2>
          </div>

          <div className="model-pill">
            <span className="live-dot" />
            <span>{MODEL}</span>
          </div>
        </header>

        <section className="companion-banner">
          <div className="avatar-wrap">
            <div className="avatar-halo" />
            <div className="avatar">🌸</div>
            <span className="avatar-status" />
          </div>

          <div className="companion-info">
            <span className="eyebrow">YOUR AI COMPANION</span>
            <h3>
              Sakura <span className="heart">✿</span>
            </h3>
            <p>A little space to think, create, and talk.</p>
            <div className="status-line">
              <span className="live-dot" />
              {!storageReady
                ? storageStatus
                : busy
                  ? "Thinking..."
                  : "Ready to chat"}
            </div>
          </div>

          <div className="banner-decoration">花</div>
        </section>

        <section className="chat-panel">
          <div className="chat-heading">
            <div>
              <h3>Conversation</h3>
              <p>{storageStatus}</p>
            </div>

            <span className="local-tag">● LOCAL AI</span>
          </div>

          <div className="messages">
            {messages.map((message, index) => (
              <div className={`message-row ${message.role}`} key={index}>
                {message.role === "assistant" && (
                  <div className="message-avatar">桜</div>
                )}

                <div className="message-content">
                  <span className="message-author">
                    {message.role === "assistant" ? "Sakura" : "You"}
                  </span>

                  <div className="message-bubble">
                    {message.content ||
                      (busy && index === messages.length - 1
                        ? "Thinking"
                        : "")}

                    {busy &&
                      message.role === "assistant" &&
                      index === messages.length - 1 && (
                        <span className="typing-dots"> ···</span>
                      )}
                  </div>
                </div>

                {message.role === "user" && (
                  <div className="user-avatar">K</div>
                )}
              </div>
            ))}

            <div ref={bottomRef} />
          </div>

          {error && <div className="error-message">{error}</div>}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder="Talk to Sakura... (Enter to send)"
              rows={2}
              disabled={busy || !storageReady}
            />

            <div className="composer-footer">
              <span>✧ Running on your own hardware</span>
              <button
                type="submit"
                className="send-button"
                disabled={busy || !input.trim() || !storageReady}
              >
                {busy ? "Thinking..." : "Send ↗"}
              </button>
            </div>
          </form>
        </section>

        <footer className="app-footer">
          <span>SAKURA COMPANION</span>
          <span>Built for your little corner of the world ♡</span>
        </footer>
      </section>
    </main>
  );
}
