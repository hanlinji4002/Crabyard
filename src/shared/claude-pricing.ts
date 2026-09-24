// API list prices for Claude models, in USD per million tokens. Used to turn
// transcript token counts into a cost *estimate*: subscription plans are not
// billed per token, so this is "what the same traffic would cost on the API".
//
// Cache writes are priced off the input rate (5-minute TTL 1.25x, 1-hour TTL
// 2x); cache reads carry their own per-model rate because the newest models
// dropped below the usual 0.1x (Opus 5.5 $0.20, Fable 5.1 $0.25).

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
/** Fast mode (`usage.speed === 'fast'`) bills 2x the standard rates. */
const FAST_MODE_MULTIPLIER = 2;

/** Exact model ids (date suffixes stripped by `normalizeModelId`). */
const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-3-7-sonnet': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08 },
};

/** Strip provider prefixes and `-YYYYMMDD` / `@YYYYMMDD` snapshot suffixes. */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z-]+\.)?anthropic[./]/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/[-@]\d{8}(?:-v\d+(?::\d+)?)?$/, '');
}

export function priceForModel(model: string): ModelPrice | undefined {
  return PRICES[normalizeModelId(model)];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  fast?: boolean;
}

/** Estimated API cost in USD, or `undefined` when the model has no known price. */
export function estimateCostUsd(model: string, usage: TokenUsage): number | undefined {
  const price = priceForModel(model);
  if (!price) return undefined;
  const perToken =
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheWrite5m * price.input * CACHE_WRITE_5M_MULTIPLIER +
    usage.cacheWrite1h * price.input * CACHE_WRITE_1H_MULTIPLIER +
    usage.cacheRead * price.cacheRead;
  return (perToken / 1_000_000) * (usage.fast ? FAST_MODE_MULTIPLIER : 1);
}
