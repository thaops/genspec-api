import { randomUUID } from 'node:crypto';

/**
 * Chat sessions — mỗi estimate có nhiều phiên chat độc lập thay vì một
 * conversation vĩnh viễn (history cũ bơm vào prompt làm model nhiễu).
 * Pure helpers tách riêng để test không cần Mongoose.
 */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  messages: any[];
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export const MAX_CHAT_SESSIONS = 20;
export const MAX_SESSION_MESSAGES = 100;
export const SESSION_TITLE_MAX = 60;

/** Title mặc định ("Chat 3", "Hội thoại cũ") — được phép thay bằng câu hỏi đầu tiên. */
export function isDefaultTitle(title: string): boolean {
  return /^Chat \d+$/.test(title ?? '') || title === 'Hội thoại cũ';
}

/** Migration mềm: bọc conversationMessages cũ thành 1 session "legacy". */
export function wrapLegacyConversation(messages: any[]): ChatSession {
  const now = new Date().toISOString();
  const first = Array.isArray(messages) ? messages[0] : undefined;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  return {
    id: 'legacy',
    title: 'Hội thoại cũ',
    createdAt: typeof first?.timestamp === 'string' ? first.timestamp : now,
    updatedAt: typeof last?.timestamp === 'string' ? last.timestamp : now,
    messages: Array.isArray(messages) ? messages : [],
  };
}

/** Session rỗng mới — title "Chat n+1" theo số session hiện có. */
export function newChatSession(existingCount: number): ChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: `Chat ${existingCount + 1}`,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/** Title = 60 ký tự đầu của user message đầu tiên, chỉ khi title còn mặc định. */
export function deriveTitle(currentTitle: string, messages: any[]): string {
  if (!isDefaultTitle(currentTitle)) return currentTitle;
  const firstUser = (messages ?? []).find(
    (m: any) => m?.kind === 'user' && typeof m.text === 'string' && m.text.trim(),
  );
  if (!firstUser) return currentTitle;
  const text = String(firstUser.text).trim().replace(/\s+/g, ' ');
  return text.length > SESSION_TITLE_MAX ? text.slice(0, SESSION_TITLE_MAX) + '…' : text;
}

/** Cap 20 sessions/estimate — xoá cũ nhất (theo createdAt) khi vượt. */
export function capSessions(sessions: ChatSession[]): ChatSession[] {
  if (sessions.length <= MAX_CHAT_SESSIONS) return sessions;
  return [...sessions]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(sessions.length - MAX_CHAT_SESSIONS);
}

/** Session mới nhất theo updatedAt (endpoint cũ /conversation proxy vào đây). */
export function latestSession(sessions: ChatSession[]): ChatSession | undefined {
  let best: ChatSession | undefined;
  for (const s of sessions ?? []) {
    if (!best || Date.parse(s.updatedAt) >= Date.parse(best.updatedAt)) best = s;
  }
  return best;
}

export function toSessionMeta(s: ChatSession): ChatSessionMeta {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: (s.messages ?? []).length,
  };
}
