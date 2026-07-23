import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AiUsageRecordedEvent } from '../events/domain-events';
import { computeCostUsd, getModelPricing } from './pricing.config';

export type GeminiPart = { inlineData: { data: string; mimeType: string } } | { text: string };

/** One streamed chunk — `thought: true` carries the model's reasoning summary. */
export type StreamChunk = { text: string; thought: boolean };

/** Attribution for AiUsage tracking — all fields optional, purely additive. */
export interface AiUsageContext {
  userId?: string;
  estimateId?: string;
  sessionId?: string;
  requestId?: string;
  traceId?: string;
  source?: string;
  mode?: string;
}

interface UsageMeta {
  model?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private _gemini?: GoogleGenerativeAI | null;
  private readonly geminiKey?: string;
  private readonly geminiSearchModels: string[];
  private readonly geminiEstimateModels: string[];
  private readonly thinkingBudget: number;

  constructor(
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.geminiKey = this.config.get<string>('GEMINI_API_KEY');
    // Default gemini-2.5-flash — đo thật 07/2026 với key hiện tại (đã bật billing):
    // grounding (Google Search) CHẠY, trả 3-16 groundingChunks, latency 3-13s. Đây vẫn
    // là model tốt nhất cho research: nhanh + ổn định.
    // Các model khác đã đo, KHÔNG dùng làm default:
    //   - gemini-3.5-flash      : ground được (16 chunks) nhưng ~120s → vượt mọi timeout.
    //   - gemini-3-flash-preview: HTTP 503 "high demand" (~107s mới trả lỗi).
    //   - gemini-flash-latest   : HTTP 503 thường xuyên → chỉ giữ làm fallback.
    //   - gemini-2.5-pro / 2.0-flash / 2.5-flash-lite: HTTP 404, không còn cho key mới.
    // Override qua env GEMINI_MODEL/GEMINI_SEARCH_MODEL khi có model mới ground nhanh hơn.
    const estimate = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash';
    const search = this.config.get<string>('GEMINI_SEARCH_MODEL') ?? 'gemini-2.5-flash';
    this.geminiEstimateModels = [...new Set([estimate, 'gemini-flash-latest', 'gemini-2.5-flash'])];
    this.geminiSearchModels = [...new Set([search, 'gemini-flash-latest', 'gemini-2.5-flash'])];
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

  /**
   * Fire-and-forget: emits AiUsageRecordedEvent (not awaited) right after a call
   * finishes so a slow/failed Mongo write can never delay or break the AI
   * response. Provider-agnostic shape — any future non-Gemini provider maps
   * into the same fields.
   */
  private recordUsage(
    ctx: AiUsageContext | undefined,
    meta: UsageMeta | undefined,
    latencyMs: number,
    status: 'success' | 'error' | 'timeout',
    errorMessage?: string,
  ) {
    const model = meta?.model ?? this.geminiEstimateModels[0];
    const inputTokens = meta?.promptTokenCount ?? 0;
    const outputTokens = meta?.candidatesTokenCount ?? 0;
    const totalTokens = meta?.totalTokenCount ?? inputTokens + outputTokens;
    const pricing = getModelPricing(model);
    this.eventEmitter.emit(
      AiUsageRecordedEvent.EVENT,
      new AiUsageRecordedEvent({
        requestId: ctx?.requestId ?? randomUUID(),
        traceId: ctx?.traceId,
        userId: ctx?.userId,
        estimateId: ctx?.estimateId,
        sessionId: ctx?.sessionId,
        source: ctx?.source ?? 'other',
        mode: ctx?.mode,
        provider: 'gemini',
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens: meta?.cachedContentTokenCount,
        inputPricePer1M: pricing.inputPer1M,
        outputPricePer1M: pricing.outputPer1M,
        costUsd: computeCostUsd(inputTokens, outputTokens, pricing),
        latencyMs,
        status,
        errorMessage,
      }),
    );
  }

  async research(
    query: string,
    ctx?: AiUsageContext,
  ): Promise<{ text: string; sources: { title?: string; uri?: string }[] }> {
    const start = Date.now();
    const usage: UsageMeta = {};
    const viaGemini = await this.researchGemini(query, usage);
    const latencyMs = Date.now() - start;
    if (viaGemini) {
      this.recordUsage(ctx, usage, latencyMs, 'success');
      return viaGemini;
    }
    this.recordUsage(ctx, usage, latencyMs, 'error', 'research: no result on any model');
    return { text: '', sources: [] };
  }

  private async researchGemini(
    query: string,
    usage: UsageMeta,
  ): Promise<{ text: string; sources: { title?: string; uri?: string }[] } | null> {
    if (!this.gemini) {
      return null;
    }
    // Deadline TỔNG cho cả vòng model×attempt. Trước sizing cho tình huống key
    // free-tier không có grounding (bỏ cuộc sớm). Nay grounding chạy thật và call
    // grounded đo được 3-13s → 30s quá chặt: 1 call chậm là hết sạch ngân sách,
    // không còn chỗ cho fallback. Nới 45s để 1 attempt chậm vẫn còn lượt model sau.
    const OVERALL_MS = 45000;
    const ATTEMPT_MS = 25000;
    const deadline = Date.now() + OVERALL_MS;
    for (const modelName of this.geminiSearchModels) {
      if (Date.now() >= deadline) break;
      const model = this.gemini.getGenerativeModel({
        model: modelName,
        tools: [{ googleSearch: {} }] as unknown as never,
      });
      for (let attempt = 1; attempt <= 2; attempt++) {
        const budget = deadline - Date.now();
        if (budget <= 0) return null;
        try {
          // Timeout min(ATTEMPT_MS, ngân sách còn lại của deadline tổng).
          const timeout = new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('research timeout')), Math.min(ATTEMPT_MS, budget)),
          );
          const r = await Promise.race([model.generateContent(query), timeout]);
          usage.model = modelName;
          Object.assign(usage, r.response.usageMetadata ?? {});
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
            this.logger.warn(`Gemini research (${modelName}): rỗng cả text lẫn sources`);
            return null;
          }
          return { text, sources };
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (msg === 'research timeout') {
            // Bỏ model này sang model kế (deadline tổng vẫn chặn treo), thay vì
            // bỏ cuộc cả vòng — 1 model chậm không nên giết luôn lượt fallback.
            this.logger.warn(`Gemini research (${modelName}) timed out — thử model kế`);
            break;
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

  async reviewGemini(prompt: string, ctx?: AiUsageContext): Promise<string> {
    const start = Date.now();
    const usage: UsageMeta = {};
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
          usage.model = modelName;
          Object.assign(usage, r.response.usageMetadata ?? {});
          this.recordUsage(ctx, usage, Date.now() - start, 'success');
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
    this.recordUsage(ctx, usage, Date.now() - start, 'error', 'reviewGemini failed on all models');
    return '';
  }

  async *stream(parts: GeminiPart[], opts?: { thinkingBudget?: number; ctx?: AiUsageContext }): AsyncGenerator<StreamChunk> {
    if (!this.geminiKey) {
      throw new Error('No AI backend available');
    }
    yield* this.streamGemini(parts, opts);
  }

  private async *streamGemini(
    parts: GeminiPart[],
    opts?: { thinkingBudget?: number; ctx?: AiUsageContext },
  ): AsyncGenerator<StreamChunk> {
    const start = Date.now();
    const usage: UsageMeta = {};
    let status: 'success' | 'error' = 'success';
    let errorMessage: string | undefined;
    try {
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
          usage.model = model;
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
                const obj = JSON.parse(json) as {
                  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
                  usageMetadata?: UsageMeta;
                };
                if (obj.usageMetadata) Object.assign(usage, obj.usageMetadata);
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
      status = 'error';
      errorMessage = (lastErr as Error)?.message ?? 'Gemini stream failed';
      throw lastErr ?? new Error('Gemini stream failed');
    } catch (err) {
      status = 'error';
      errorMessage = (err as Error).message;
      throw err;
    } finally {
      this.recordUsage(opts?.ctx, usage, Date.now() - start, status, errorMessage);
    }
  }

  async generate(parts: GeminiPart[], ctx?: AiUsageContext): Promise<string> {
    const start = Date.now();
    const usage: UsageMeta = {};
    const viaGemini = await this.generateGemini(parts, usage);
    const latencyMs = Date.now() - start;
    if (viaGemini != null) {
      this.recordUsage(ctx, usage, latencyMs, 'success');
      return viaGemini;
    }
    this.recordUsage(ctx, usage, latencyMs, 'error', 'No AI backend available');
    throw new Error('No AI backend available');
  }

  private async generateGemini(parts: GeminiPart[], usage: UsageMeta): Promise<string | null> {
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
          usage.model = modelName;
          Object.assign(usage, r.response.usageMetadata ?? {});
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
  async generateJson(parts: GeminiPart[], schema?: object, ctx?: AiUsageContext): Promise<string> {
    const start = Date.now();
    const usage: UsageMeta = {};
    if (!this.gemini) {
      this.recordUsage(ctx, usage, Date.now() - start, 'error', 'No AI backend available');
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
          usage.model = modelName;
          Object.assign(usage, r.response.usageMetadata ?? {});
          this.recordUsage(ctx, usage, Date.now() - start, 'success');
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
    this.recordUsage(ctx, usage, Date.now() - start, 'error', 'generateJson failed on all models');
    throw new Error('Gemini generateJson failed on all models');
  }

  /**
   * AGENTIC TOOL LOOP (ReAct): model gọi tool (functionDeclarations) → BE thực thi
   * → feed kết quả lại → lặp tới khi model trả text cuối (không còn gọi tool) hoặc
   * hết maxSteps. `executor(name,args)` do caller cấp (giữ ai.service domain-agnostic).
   * FAIL-SAFE: mọi lỗi → null để caller fallback về luồng cũ. Trả text cuối của model.
   */
  async runToolLoop(
    parts: GeminiPart[],
    functionDeclarations: unknown[],
    executor: (name: string, args: Record<string, any>) => unknown,
    opts?: { maxSteps?: number; ctx?: AiUsageContext },
  ): Promise<string | null> {
    const start = Date.now();
    const usage: UsageMeta = {};
    if (!this.gemini) return null;
    const maxSteps = opts?.maxSteps ?? 4;
    for (const modelName of this.geminiEstimateModels) {
      try {
        const model = this.gemini.getGenerativeModel({
          model: modelName,
          tools: [{ functionDeclarations }] as unknown as never,
        });
        const contents: any[] = [{ role: 'user', parts }];
        for (let step = 0; step < maxSteps; step++) {
          const r = await model.generateContent({
            contents: contents as unknown as never,
            generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } } as unknown as never,
          });
          usage.model = modelName;
          Object.assign(usage, r.response.usageMetadata ?? {});
          const calls = (typeof r.response.functionCalls === 'function' ? r.response.functionCalls() : []) ?? [];
          if (!calls.length) {
            this.recordUsage(opts?.ctx, usage, Date.now() - start, 'success');
            return r.response.text();
          }
          // Append lượt model (chứa functionCall) + kết quả tool (functionResponse).
          const modelParts = r.response.candidates?.[0]?.content?.parts ?? [];
          contents.push({ role: 'model', parts: modelParts });
          contents.push({
            role: 'user',
            parts: calls.map((c: any) => ({
              functionResponse: { name: c.name, response: { result: this.safeExec(executor, c.name, c.args ?? {}) } },
            })),
          });
        }
        // Hết bước — 1 lượt cuối KHÔNG tool để lấy kết luận.
        const fin = await model.generateContent({ contents: contents as unknown as never });
        usage.model = modelName;
        Object.assign(usage, fin.response.usageMetadata ?? {});
        this.recordUsage(opts?.ctx, usage, Date.now() - start, 'success');
        return fin.response.text();
      } catch (err) {
        if (!this.isTransient(err)) {
          this.logger.warn(`runToolLoop (${modelName}) failed: ${(err as Error).message}`);
          this.recordUsage(opts?.ctx, usage, Date.now() - start, 'error', (err as Error).message);
          return null;
        }
        await this.sleep(1500);
      }
    }
    this.recordUsage(opts?.ctx, usage, Date.now() - start, 'error', 'runToolLoop failed on all models');
    return null;
  }

  private safeExec(executor: (n: string, a: Record<string, any>) => unknown, name: string, args: Record<string, any>): unknown {
    try {
      return executor(name, args);
    } catch (e) {
      return { error: (e as Error).message };
    }
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
