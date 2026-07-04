import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type GeminiPart = { inlineData: { data: string; mimeType: string } } | { text: string };

/** One streamed chunk — `thought: true` carries the model's reasoning summary. */
export type StreamChunk = { text: string; thought: boolean };

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private _gemini?: GoogleGenerativeAI | null;
  private readonly geminiKey?: string;
  private readonly geminiSearchModels: string[];
  private readonly geminiEstimateModels: string[];
  private readonly thinkingBudget: number;

  constructor(private readonly config: ConfigService) {
    this.geminiKey = this.config.get<string>('GEMINI_API_KEY');
    const estimate = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash';
    const search = this.config.get<string>('GEMINI_SEARCH_MODEL') ?? 'gemini-2.5-flash';
    this.geminiEstimateModels = [...new Set([estimate, 'gemini-2.5-flash-lite', 'gemini-flash-latest'])];
    this.geminiSearchModels = [...new Set([search, 'gemini-2.5-flash-lite', 'gemini-flash-latest'])];
    // -1 = dynamic (model decides), 0 = off
    this.thinkingBudget = Number(this.config.get<string>('GEMINI_THINKING_BUDGET') ?? -1);
    if (!this.geminiKey) {
      this.logger.warn('No AI backend (GEMINI_API_KEY) — AI features disabled');
    }
  }

  private get gemini(): GoogleGenerativeAI | undefined {
    if (this._gemini === undefined) {
      this._gemini = this.geminiKey ? new GoogleGenerativeAI(this.geminiKey) : null;
    }
    return this._gemini ?? undefined;
  }

  get available(): boolean {
    return !!this.gemini;
  }

  async research(query: string): Promise<{ text: string; sources: { title?: string; uri?: string }[] }> {
    const viaGemini = await this.researchGemini(query);
    if (viaGemini) {
      return viaGemini;
    }
    return { text: '', sources: [] };
  }

  private async researchGemini(
    query: string,
  ): Promise<{ text: string; sources: { title?: string; uri?: string }[] } | null> {
    if (!this.gemini) {
      return null;
    }
    for (const modelName of this.geminiSearchModels) {
      const model = this.gemini.getGenerativeModel({
        model: modelName,
        tools: [{ googleSearch: {} }] as unknown as never,
      });
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // 20-second timeout — grounding can be slow but shouldn't block the whole response
          const timeout = new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('research timeout')), 20000),
          );
          const r = await Promise.race([model.generateContent(query), timeout]);
          const text = r.response.text();
          const meta = (
            r.response.candidates?.[0] as {
              groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
            }
          )?.groundingMetadata;
          const sources = (meta?.groundingChunks ?? [])
            .map((c) => ({ title: c.web?.title, uri: c.web?.uri }))
            .filter((s) => !!s.uri);
          if (!text && sources.length === 0) {
            this.logger.warn(`Gemini research (${modelName}): empty — grounding may be unavailable for this key tier`);
            return null;
          }
          return { text, sources };
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (msg === 'research timeout') {
            this.logger.warn(`Gemini research (${modelName}) timed out after 20s`);
            return null;
          }
          if (!this.isTransient(err)) {
            this.logger.warn(`Gemini research (${modelName}) failed: ${msg}`);
            break;
          }
          await this.sleep(Math.min(1500 * attempt * attempt, 6000));
        }
      }
    }
    return null;
  }

  async reviewGemini(prompt: string): Promise<string> {
    if (!this.gemini) {
      return '';
    }
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
    return '';
  }

  async *stream(parts: GeminiPart[], opts?: { thinkingBudget?: number }): AsyncGenerator<StreamChunk> {
    if (!this.geminiKey) {
      throw new Error('No AI backend available');
    }
    yield* this.streamGemini(parts, opts);
  }

  private async *streamGemini(parts: GeminiPart[], opts?: { thinkingBudget?: number }): AsyncGenerator<StreamChunk> {
    const budget = opts?.thinkingBudget ?? this.thinkingBudget;
    const body = JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.2,
        // Dynamic thinking with thought summaries streamed back — surfaced to the
        // client as `thinking` events so the UI can show live reasoning.
        // budget 0 disables thinking entirely (used as retry when the model
        // burns its whole output on thoughts and returns no answer text).
        thinkingConfig: budget === 0 ? { thinkingBudget: 0 } : { thinkingBudget: budget, includeThoughts: true },
      },
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
          if (done) {
            return;
          }
          buf = (buf + dec.decode(value, { stream: true })).replace(/\r/g, '');
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) {
              continue;
            }
            const json = dataLine.slice(5).trim();
            if (!json || json === '[DONE]') {
              continue;
            }
            try {
              const obj = JSON.parse(json) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
              // Thought parts stream separately (thought: true) so downstream
              // parsers only ever see answer text in non-thought chunks.
              const partsArr = obj.candidates?.[0]?.content?.parts ?? [];
              const thoughtTx = partsArr.filter((p) => p.thought).map((p) => p.text ?? '').join('');
              const tx = partsArr.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
              if (thoughtTx) {
                yield { text: thoughtTx, thought: true };
              }
              if (tx) {
                yield { text: tx, thought: false };
              }
            } catch {}
          }
        }
      }
    }
    throw lastErr ?? new Error('Gemini stream failed');
  }

  async generate(parts: GeminiPart[]): Promise<string> {
    const viaGemini = await this.generateGemini(parts);
    if (viaGemini != null) {
      return viaGemini;
    }
    throw new Error('No AI backend available');
  }

  private async generateGemini(parts: GeminiPart[]): Promise<string | null> {
    if (!this.gemini) {
      return null;
    }
    for (const modelName of this.geminiEstimateModels) {
      const model = this.gemini.getGenerativeModel({ model: modelName });
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await model.generateContent({
            contents: [{ role: 'user', parts: parts as unknown as never }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } } as unknown as never,
          });
          return r.response.text();
        } catch (err) {
          if (!this.isTransient(err)) {
            this.logger.warn(`Gemini generate (${modelName}) failed: ${(err as Error).message}`);
            break;
          }
          await this.sleep(Math.min(1500 * attempt * attempt, 8000));
        }
      }
    }
    return null;
  }

  /**
   * Non-stream JSON-mode generation: forces `application/json` output and,
   * when given, an OpenAPI-style responseSchema so the model cannot wrap the
   * payload in prose/markdown. Same model-fallback + transient-retry chain
   * as generate(). Returns the raw JSON text.
   */
  async generateJson(parts: GeminiPart[], schema?: object): Promise<string> {
    if (!this.gemini) {
      throw new Error('No AI backend available');
    }
    for (const modelName of this.geminiEstimateModels) {
      const model = this.gemini.getGenerativeModel({ model: modelName });
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await model.generateContent({
            contents: [{ role: 'user', parts: parts as unknown as never }],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
              ...(schema && { responseSchema: schema }),
              thinkingConfig: { thinkingBudget: 0 },
            } as unknown as never,
          });
          return r.response.text();
        } catch (err) {
          if (!this.isTransient(err)) {
            this.logger.warn(`Gemini generateJson (${modelName}) failed: ${(err as Error).message}`);
            break;
          }
          await this.sleep(Math.min(1500 * attempt * attempt, 8000));
        }
      }
    }
    throw new Error('Gemini generateJson failed on all models');
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private isTransient(err: unknown): boolean {
    const msg = (err as Error)?.message ?? '';
    return /(HTTP |\[)(429|500|502|503)|Service Unavailable|high demand|overloaded|rate-limit|Too Many Requests|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(
      msg,
    );
  }
}
