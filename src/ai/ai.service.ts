import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Kept the name for backward-compat with copilot.service. A "part" is either text
// or inline binary (image/pdf) — we translate it to OpenRouter (OpenAI) content blocks.
export type GeminiPart = { inlineData: { data: string; mimeType: string } } | { text: string };

type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

// OpenRouter web-search citation (`message.annotations[]`).
type UrlAnnotation = { type?: string; url_citation?: { url?: string; title?: string } };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly apiKey?: string;
  private readonly models: string[];
  private readonly webSearch: boolean;
  private readonly webMaxResults: number;
  // Gemini is the PRIMARY engine for review + takeoff (multimodal — reads drawings,
  // strong VN) and for grounded web search. The OpenRouter chain is the fallback when
  // Gemini errors / hits quota.
  private readonly gemini?: GoogleGenerativeAI;
  private readonly geminiKey?: string;
  private readonly geminiSearchModels: string[];
  private readonly geminiEstimateModels: string[];

  constructor(private readonly config: ConfigService) {
    // OpenRouter (OpenAI-compatible) — FALLBACK reasoning/estimate engine.
    this.apiKey = this.config.get<string>('OPENROUTER_API_KEY');
    // Quality-first chain: Qwen3-next (best QS/JSON) → Gemma-4-31b → 26b → gpt-oss-120b.
    // Drop to the next model only when the higher-priority one errors / 429 / quota-outs.
    const chain = [
      this.config.get<string>('OPENROUTER_MODEL') ?? 'qwen/qwen3-next-80b-a3b-instruct:free',
      this.config.get<string>('OPENROUTER_MODEL_FALLBACK') ?? 'google/gemma-4-31b-it:free',
      this.config.get<string>('OPENROUTER_MODEL_FALLBACK2') ?? 'google/gemma-4-26b-a4b-it:free',
      this.config.get<string>('OPENROUTER_MODEL_FALLBACK3') ?? 'openai/gpt-oss-120b:free',
    ];
    this.models = [...new Set(chain)];
    // Web search (Exa plugin) — paid (~$0.005/req). Off by default; only a last resort
    // for research() when Gemini grounding isn't configured.
    this.webSearch = /^(1|true|yes)$/i.test(this.config.get<string>('OPENROUTER_WEB_SEARCH') ?? '');
    this.webMaxResults = Number(this.config.get<string>('OPENROUTER_WEB_MAX_RESULTS') ?? 4) || 4;

    // Gemini — PRIMARY for estimate/review/takeoff + grounded search.
    this.geminiKey = this.config.get<string>('GEMINI_API_KEY');
    const estimate = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash';
    const search = this.config.get<string>('GEMINI_SEARCH_MODEL') ?? 'gemini-2.5-flash';
    this.geminiEstimateModels = [...new Set([estimate, 'gemini-2.5-flash-lite', 'gemini-flash-latest'])];
    this.geminiSearchModels = [...new Set([search, 'gemini-2.5-flash-lite', 'gemini-flash-latest'])];
    if (this.geminiKey) this.gemini = new GoogleGenerativeAI(this.geminiKey);

    if (!this.gemini && !this.apiKey)
      this.logger.warn('No AI backend (GEMINI_API_KEY / OPENROUTER_API_KEY) — AI features disabled');
  }

  get available(): boolean {
    return !!this.gemini || !!this.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.config.get<string>('FRONTEND_URL') ?? 'https://genspec.app',
      'X-Title': 'GenSpec',
    };
  }

  /** Translate our text/inline parts into OpenRouter message content blocks. */
  private toContent(parts: GeminiPart[]): ChatContent[] {
    return parts.map((p) => {
      if ('text' in p) return { type: 'text', text: p.text };
      const { data, mimeType } = p.inlineData;
      const url = `data:${mimeType};base64,${data}`;
      if (mimeType === 'application/pdf') {
        return { type: 'file', file: { filename: 'attachment.pdf', file_data: url } };
      }
      return { type: 'image_url', image_url: { url } };
    });
  }

  private hasPdf(parts: GeminiPart[]): boolean {
    return parts.some((p) => 'inlineData' in p && p.inlineData.mimeType === 'application/pdf');
  }

  /**
   * Grounded research. Priority:
   *  1) Gemini + Google Search grounding (free under Gemini quota, best-quality citations)
   *  2) OpenRouter `web` (Exa) plugin if OPENROUTER_WEB_SEARCH is on (paid)
   *  3) Plain OpenRouter completion (no sources → prices marked "ai_estimate")
   */
  async research(query: string): Promise<{ text: string; sources: { title?: string; uri?: string }[] }> {
    const viaGemini = await this.researchGemini(query);
    if (viaGemini) return viaGemini;

    if (!this.apiKey) return { text: '', sources: [] };
    try {
      const { content, annotations } = await this.complete([{ text: query }], {
        json: false,
        maxTokens: 1800,
        web: this.webSearch,
      });
      const sources = annotations
        .map((a) => ({ title: a.url_citation?.title, uri: a.url_citation?.url }))
        .filter((s) => !!s.uri);
      return { text: content, sources };
    } catch (err) {
      this.logger.warn(`research failed: ${(err as Error).message}`);
      return { text: '', sources: [] };
    }
  }

  /** Gemini Google-Search-grounded research; null when Gemini isn't configured/all models fail. */
  private async researchGemini(
    query: string,
  ): Promise<{ text: string; sources: { title?: string; uri?: string }[] } | null> {
    if (!this.gemini) return null;
    for (const modelName of this.geminiSearchModels) {
      const model = this.gemini.getGenerativeModel({
        model: modelName,
        tools: [{ googleSearch: {} }] as unknown as never,
      });
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await model.generateContent(query);
          const text = r.response.text();
          const meta = (
            r.response.candidates?.[0] as {
              groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
            }
          )?.groundingMetadata;
          const sources = (meta?.groundingChunks ?? [])
            .map((c) => ({ title: c.web?.title, uri: c.web?.uri }))
            .filter((s) => !!s.uri);
          return { text, sources };
        } catch (err) {
          if (!this.isTransient(err)) {
            this.logger.warn(`Gemini research (${modelName}) failed: ${(err as Error).message}`);
            break; // hard error → try next gemini model
          }
          await this.sleep(Math.min(1500 * attempt * attempt, 6000));
        }
      }
    }
    this.logger.warn('Gemini research exhausted — falling back to OpenRouter');
    return null;
  }

  /**
   * Gemini REVIEWER (web-grounded). Gemini's primary role: read the estimate Qwen
   * produced, reach the web to verify prices/định mức, and report what's wrong/made-up.
   * Returns the critique text (Qwen then applies the fix). '' when Gemini unavailable.
   */
  async reviewGemini(prompt: string): Promise<string> {
    if (!this.gemini) return '';
    for (const modelName of this.geminiSearchModels) {
      const model = this.gemini.getGenerativeModel({
        model: modelName,
        tools: [{ googleSearch: {} }] as unknown as never,
      });
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await model.generateContent(prompt);
          return r.response.text();
        } catch (err) {
          if (!this.isTransient(err)) {
            this.logger.warn(`Gemini review (${modelName}) failed: ${(err as Error).message}`);
            break;
          }
          await this.sleep(Math.min(1500 * attempt * attempt, 6000));
        }
      }
    }
    this.logger.warn('Gemini review exhausted');
    return '';
  }

  /**
   * Stream raw text chunks — the MAIN estimator (Qwen via OpenRouter). If OpenRouter
   * fails BEFORE emitting anything, fall back to Gemini. A mid-stream failure is rethrown
   * (can't safely restart a half-emitted stream).
   */
  async *stream(parts: GeminiPart[]): AsyncGenerator<string> {
    if (this.apiKey) {
      let emitted = false;
      try {
        for await (const chunk of this.streamOpenRouter(parts)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (emitted) throw err;
        this.logger.warn(`OpenRouter stream failed pre-output, falling back to Gemini: ${(err as Error).message}`);
      }
    }
    if (!this.geminiKey) throw new Error('No AI backend available');
    yield* this.streamGemini(parts);
  }

  /** Gemini SSE stream (REST `streamGenerateContent?alt=sse`), rotating fallback models. */
  private async *streamGemini(parts: GeminiPart[]): AsyncGenerator<string> {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2 },
    });
    let lastErr: unknown;
    for (const model of this.geminiEstimateModels) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.geminiKey}`;
        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        } catch (err) {
          lastErr = err;
          await this.sleep(1200 * attempt);
          continue;
        }
        if (res.status === 429 || res.status === 503 || res.status === 500) {
          lastErr = new Error(`Gemini stream HTTP ${res.status}`);
          await this.sleep(Math.min(1500 * attempt * attempt, 6000));
          continue;
        }
        if (!res.ok || !res.body) {
          throw new Error(`Gemini stream HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf = (buf + dec.decode(value, { stream: true })).replace(/\r/g, '');
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
      this.logger.warn(`Gemini stream model ${model} exhausted, trying next`);
    }
    throw lastErr ?? new Error('Gemini stream failed');
  }

  /** OpenRouter SSE stream (`stream: true`), parsing `choices[].delta.content`. */
  private async *streamOpenRouter(parts: GeminiPart[]): AsyncGenerator<string> {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY missing');
    const body = JSON.stringify(this.payload(parts, { json: false, maxTokens: 4000, stream: true }));

    let lastErr: unknown;
    for (const model of this.models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        let res: Response;
        try {
          res = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: this.headers(),
            body: body.replace(/"model":"[^"]*"/, `"model":"${model}"`),
          });
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
          buf = (buf + dec.decode(value, { stream: true })).replace(/\r/g, '');
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json || json === '[DONE]') continue;
            try {
              const obj = JSON.parse(json) as { choices?: { delta?: { content?: string } }[] };
              const tx = obj.choices?.[0]?.delta?.content ?? '';
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

  /**
   * Non-streaming JSON completion — the MAIN generator (Qwen via OpenRouter). Gemini is
   * only a last-resort fallback so the app still works if OpenRouter is fully down;
   * Gemini's real job is reviewGemini() (web-grounded critique), not generation.
   */
  async generate(parts: GeminiPart[]): Promise<string> {
    if (this.apiKey) {
      try {
        return (await this.complete(parts, { json: true, maxTokens: 4000 })).content;
      } catch (err) {
        if (!this.gemini) throw err;
        this.logger.warn(`OpenRouter generate failed, falling back to Gemini: ${(err as Error).message}`);
      }
    }
    const viaGemini = await this.generateGemini(parts);
    if (viaGemini != null) return viaGemini;
    throw new Error('No AI backend available');
  }

  /** Gemini JSON-mode generate; null when Gemini isn't configured or all models fail. */
  private async generateGemini(parts: GeminiPart[]): Promise<string | null> {
    if (!this.gemini) return null;
    for (const modelName of this.geminiEstimateModels) {
      const model = this.gemini.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      });
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await model.generateContent(parts as unknown as never);
          return r.response.text();
        } catch (err) {
          if (!this.isTransient(err)) {
            this.logger.warn(`Gemini generate (${modelName}) failed: ${(err as Error).message}`);
            break; // hard error → try next gemini model
          }
          await this.sleep(Math.min(1500 * attempt * attempt, 8000));
        }
      }
    }
    this.logger.warn('Gemini generate exhausted — falling back to OpenRouter');
    return null;
  }

  private async complete(
    parts: GeminiPart[],
    opts: { json: boolean; maxTokens: number; web?: boolean },
  ): Promise<{ content: string; annotations: UrlAnnotation[] }> {
    const body = this.payload(parts, { ...opts, stream: false });
    let lastErr: unknown;
    for (const model of this.models) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ ...body, model }),
          });
          if (this.isTransientStatus(res.status)) throw new Error(`HTTP ${res.status}`);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
          }
          const data = (await res.json()) as {
            choices?: { message?: { content?: string; annotations?: UrlAnnotation[] } }[];
          };
          const msg = data.choices?.[0]?.message;
          return { content: msg?.content ?? '', annotations: msg?.annotations ?? [] };
        } catch (err) {
          lastErr = err;
          if (!this.isTransient(err)) {
            if (model === this.models[this.models.length - 1]) throw err;
            this.logger.warn(`${model} error, trying next model: ${(err as Error).message}`);
            break; // hard error on this model → try next model
          }
          const delay = Math.min(1500 * attempt * attempt, 8000);
          this.logger.warn(`${model} transient error (attempt ${attempt}/3), retrying in ${delay}ms`);
          await this.sleep(delay);
        }
      }
      this.logger.warn(`${model} exhausted retries, trying next model`);
    }
    throw lastErr ?? new Error('AI call failed');
  }

  private payload(
    parts: GeminiPart[],
    opts: { json: boolean; maxTokens: number; stream: boolean; web?: boolean },
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.models[0],
      messages: [{ role: 'user', content: this.toContent(parts) }],
      temperature: 0.2,
      max_tokens: opts.maxTokens,
      stream: opts.stream,
    };
    if (opts.json) payload.response_format = { type: 'json_object' };
    const plugins: Record<string, unknown>[] = [];
    // PDF attachments need OpenRouter's file-parser plugin (free "pdf-text" engine).
    if (this.hasPdf(parts)) plugins.push({ id: 'file-parser', pdf: { engine: 'pdf-text' } });
    // Web search (Exa) — paid; only when explicitly requested (research()).
    if (opts.web) plugins.push({ id: 'web', max_results: this.webMaxResults });
    if (plugins.length) payload.plugins = plugins;
    return payload;
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private isTransientStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503;
  }

  private isTransient(err: unknown): boolean {
    const msg = (err as Error)?.message ?? '';
    // Matches both OpenRouter ("HTTP 429") and Gemini SDK ("[429 ...]", "GoogleGenerativeAI Error") shapes.
    return /(HTTP |\[)(429|500|502|503)|Service Unavailable|high demand|overloaded|rate-limit|Too Many Requests|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(
      msg,
    );
  }
}
