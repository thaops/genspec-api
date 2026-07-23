/**
 * Static per-model pricing snapshot (USD / 1M tokens). Gemini pricing changes
 * over time — costUsd on AiUsage records is computed at call time from this
 * table, and the table's input/output rates are also persisted on the record
 * so historical cost can be re-derived even if this map changes later.
 * Override per-model via env `AI_PRICE_<MODEL_WITH_UNDERSCORES_UPPER>` as
 * "input,output" (USD/1M) if a rate needs correcting without a deploy.
 */

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-flash-latest': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 },
};

const FALLBACK_PRICING: ModelPricing = { inputPer1M: 0.3, outputPer1M: 2.5 };

export function getModelPricing(model: string): ModelPricing {
  const envKey = `AI_PRICE_${model.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const override = process.env[envKey];
  if (override) {
    const [input, output] = override.split(',').map((v) => Number(v.trim()));
    if (Number.isFinite(input) && Number.isFinite(output)) {
      return { inputPer1M: input, outputPer1M: output };
    }
  }
  return DEFAULT_PRICING[model] ?? FALLBACK_PRICING;
}

export function computeCostUsd(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
}
