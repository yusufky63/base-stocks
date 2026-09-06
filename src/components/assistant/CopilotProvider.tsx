"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { apiPost, ApiError } from "@/lib/client-api";
import type { AssistantAction, ChatResponse } from "@/lib/assistant/schema";

export interface CopilotMessage {
  role: "user" | "assistant";
  content: string;
  actions?: AssistantAction[];
  /** Client-side failures render differently and are never sent back as history. */
  error?: boolean;
}

interface CopilotState {
  open: boolean;
  setOpen: (open: boolean) => void;
  messages: CopilotMessage[];
  sending: boolean;
  quota: number | null;
  send: (text: string) => void;
  clear: () => void;
}

const CopilotContext = createContext<CopilotState | null>(null);

const STORE_KEY = "bstocks:copilot";
const MAX_STORED = 24;

function loadStored(): CopilotMessage[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is CopilotMessage => !!m && typeof m === "object" && ((m as CopilotMessage).role === "user" || (m as CopilotMessage).role === "assistant") && typeof (m as CopilotMessage).content === "string").slice(-MAX_STORED);
  } catch {
    return [];
  }
}

/**
 * Chat state for the Copilot: history lives in sessionStorage so it survives navigation, and only
 * plain text goes back to the server — actions are render-only. One in-flight turn at a time.
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [quota, setQuota] = useState<number | null>(null);
  const hydrated = useRef(false);
  /** Read by `send` so the history it posts never depends on a stale closure or an updater. */
  const messagesRef = useRef<CopilotMessage[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    setMessages(loadStored());
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-MAX_STORED)));
    } catch {
      /* storage unavailable: chat still works for the session */
    }
  }, [messages]);

  // The request is fired here, never inside a state updater: React may run an updater twice
  // (StrictMode does in development), which would send the turn — and charge quota — twice.
  const send = useCallback(
    (raw: string) => {
      const text = raw.trim().slice(0, 1_000);
      if (!text || sending) return;
      // Last 11 real turns + the new message stay within the API's 12-message cap.
      const history = [...messagesRef.current.filter((m) => !m.error), { role: "user" as const, content: text }].slice(-12).map((m) => ({ role: m.role, content: m.content }));
      setSending(true);
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      void apiPost<ChatResponse>("/api/assistant/chat", { messages: history, owner: address, path })
        .then((res) => {
          setQuota(res.quota.remainingForWallet);
          setMessages((cur) => [...cur, { role: "assistant", content: res.reply, actions: res.actions }]);
        })
        .catch((err) => {
          const body = err instanceof ApiError ? (err.body as { errors?: string[]; quota?: { remainingForWallet?: number } } | undefined) : undefined;
          if (body?.quota?.remainingForWallet !== undefined) setQuota(body.quota.remainingForWallet);
          const msg = body?.errors?.[0] ?? (err instanceof ApiError ? err.message : "The assistant could not answer. Please try again.");
          setMessages((cur) => [...cur, { role: "assistant", content: msg, error: true }]);
        })
        .finally(() => setSending(false));
    },
    [address, path, sending],
  );

  const clear = useCallback(() => {
    setMessages([]);
    try {
      sessionStorage.removeItem(STORE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<CopilotState>(() => ({ open, setOpen, messages, sending, quota, send, clear }), [open, messages, sending, quota, send, clear]);
  return <CopilotContext.Provider value={value}>{children}</CopilotContext.Provider>;
}

export function useCopilot(): CopilotState {
  const ctx = useContext(CopilotContext);
  if (!ctx) throw new Error("useCopilot must be used inside CopilotProvider");
  return ctx;
}
