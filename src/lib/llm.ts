import { getSettings } from '../db';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export class LLMNotConfigured extends Error {
  constructor() { super('尚未設定 AI 服務：請到「設定」填入 API Key'); }
}

/** Call an OpenAI-compatible /chat/completions endpoint. */
export async function chat(messages: ChatMessage[], opts: { json?: boolean; temperature?: number; signal?: AbortSignal } = {}): Promise<string> {
  const s = await getSettings();
  if (!s.llmApiKey && !/localhost|127\.0\.0\.1/.test(s.llmBaseUrl)) throw new LLMNotConfigured();
  const url = s.llmBaseUrl.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(s.llmApiKey ? { Authorization: `Bearer ${s.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: s.llmModel,
      messages,
      temperature: opts.temperature ?? 0.3,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AI 服務錯誤 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** Ask for JSON and parse it robustly (strips ``` fences, finds first {...}). */
export async function chatJSON<T>(messages: ChatMessage[], opts: { temperature?: number; signal?: AbortSignal } = {}): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true });
  return parseJSONLoose<T>(raw);
}

export function parseJSONLoose<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
  try { return JSON.parse(cleaned) as T; } catch { /* fallthrough */ }
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
  throw new Error('AI 回傳的不是有效 JSON');
}
