import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type GeminiPart = { inlineData: { data: string; mimeType: string } } | { text: string };

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly gemini?: GoogleGenerativeAI;
  private readonly geminiKey?: string;
  private readonly geminiSearchModels: string[];
  private readonly geminiEstimateModels: string[];

  constructor(private readonly config: ConfigService) {
    this.geminiKey = this.config.get<string>('GEMINI_API_KEY');
    const estimate = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash';
    const search = this.config.get<string>('GEMINI_SEARCH_MODEL') ?? 'gemini-2.5-flash';
    this.geminiEstimateModels = [...new Set([estimate, 'gemini-2.5-flash-lite', 'gemini-flash-latest'])];
    this.geminiSearchModels = [...new Set([search, 'gemini-2.5-flash-lite', 'gemini-flash-latest'])];
    if (this.geminiKey) {
      this.gemini = new GoogleGenerativeAI(this.geminiKey);
    }
    if (!this.gemini) {
      this.logger.warn('No AI backend (GEMINI_API_KEY) — AI features disabled');
    }
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

  async *stream(parts: GeminiPart[]): AsyncGenerator<string> {
    if (!this.geminiKey) {
      throw new Error('No AI backend available');
    }
    yield* this.streamGemini(parts);
  }

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
              // Filter out Gemini 2.5 thinking (thought) parts — they appear before output text
              // and contain reasoning with JSON-like content that breaks the stream parser.
              const tx = (obj.candidates?.[0]?.content?.parts ?? [])
                .filter((p) => !p.thought)
                .map((p) => p.text ?? '')
                .join('');
              if (tx) {
                yield tx;
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
            break;
          }
          await this.sleep(Math.min(1500 * attempt * attempt, 8000));
        }
      }
    }
    return null;
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
