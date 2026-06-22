import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type GeminiPart = { inlineData: { data: string; mimeType: string } } | { text: string };

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client?: GoogleGenerativeAI;
  private readonly models: string[];

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('GEMINI_API_KEY');
    const primary = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash';
    // Try the configured model first, then less-loaded fallbacks on overload/quota.
    this.models = [...new Set([primary, 'gemini-2.5-flash-lite', 'gemini-flash-latest'])];
    if (key) this.client = new GoogleGenerativeAI(key);
    else this.logger.warn('GEMINI_API_KEY missing — AI features disabled');
  }

  get available(): boolean {
    return !!this.client;
  }

  /**
   * Grounded web research via Google Search (best-effort, no JSON mode).
   * Returns the model's text answer plus the source links it cited.
   */
  async research(query: string): Promise<{ text: string; sources: { title?: string; uri?: string }[] }> {
    if (!this.client) return { text: '', sources: [] };
    try {
      const model = this.client.getGenerativeModel({
        model: this.models[0],
        tools: [{ googleSearch: {} }] as unknown as never,
      });
      const r = await model.generateContent(query);
      const text = r.response.text();
      const meta = (r.response.candidates?.[0] as { groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } })
        ?.groundingMetadata;
      const sources = (meta?.groundingChunks ?? [])
        .map((c) => ({ title: c.web?.title, uri: c.web?.uri }))
        .filter((s) => !!s.uri);
      return { text, sources };
    } catch (err) {
      this.logger.warn(`research failed: ${(err as Error).message}`);
      return { text: '', sources: [] };
    }
  }

  /**
   * Stream raw text chunks from Gemini via the REST `streamGenerateContent?alt=sse`
   * endpoint, parsing the SSE ourselves. This avoids the SDK's flaky stream parser
   * (which throws "Failed to parse stream"), so live tokens/steps reliably flow.
   */
  async *stream(parts: GeminiPart[]): AsyncGenerator<string> {
    const key = this.config.get<string>('GEMINI_API_KEY');
    if (!key) throw new Error('GEMINI_API_KEY missing');
    const body = JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2 },
    });

    let lastErr: unknown;
    for (const model of this.models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        } catch (err) {
          lastErr = err;
          await this.sleep(1200 * attempt);
          continue;
        }
        if (res.status === 429 || res.status === 503 || res.status === 500) {
          lastErr = new Error(`stream HTTP ${res.status}`);
          await this.sleep(Math.min(1500 * attempt * attempt, 6000));
          continue; // retry same model, then fall through to next model
        }
        if (!res.ok || !res.body) {
          throw new Error(`stream HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        }
        // Success — stream the SSE body.
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json || json === '[DONE]') continue;
            try {
              const obj = JSON.parse(json) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
              const tx = (obj.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
              if (tx) yield tx;
            } catch {
              // skip partial/keep-alive frames
            }
          }
        }
      }
      this.logger.warn(`stream model ${model} exhausted, trying next`);
    }
    throw lastErr ?? new Error('stream failed');
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private isTransient(err: unknown): boolean {
    const msg = (err as Error)?.message ?? '';
    return /\[(429|500|503)|Service Unavailable|high demand|overloaded|Too Many Requests|UNAVAILABLE/i.test(
      msg,
    );
  }

  /**
   * Call Gemini (JSON mode) with retry + backoff on transient errors (429/503/500),
   * rotating through fallback models when one is overloaded or out of quota.
   */
  async generate(parts: GeminiPart[]): Promise<string> {
    if (!this.client) throw new Error('GEMINI_API_KEY missing');
    let lastErr: unknown;
    for (const modelName of this.models) {
      const model = this.client.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      });
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await model.generateContent(parts);
          return result.response.text();
        } catch (err) {
          lastErr = err;
          if (!this.isTransient(err)) throw err;
          const delay = Math.min(1500 * attempt * attempt, 8000);
          this.logger.warn(
            `${modelName} transient error (attempt ${attempt}/3), retrying in ${delay}ms`,
          );
          await this.sleep(delay);
        }
      }
      this.logger.warn(`${modelName} exhausted retries, trying next model`);
    }
    throw lastErr ?? new Error('Gemini call failed');
  }
}
