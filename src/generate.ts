/**
 * 提供元をまたぐ 3 段のフォールバック戦略。urban_legend/tools/images.py の
 * generate() を汎用化して移植したもの。**この順番を入れ替えない。**
 *
 *   1. gpt-image-2 に情景文をそのまま投げる
 *   2. 拒否されたら同じ文のまま grok-imagine-image へ投げる
 *      （OpenAI と xAI で安全フィルタの当たり所が違うので、文を弱める前に
 *      提供元を替える方が絵が残る）
 *   3. それでも駄目なら安全側の追記を足して gpt-image-2 へ。主題が消えるので degraded として返す
 *
 * 各段は 3 回まで指数バックオフで粘るが、400（内容が弾かれた）だけは
 * 同じ文で粘っても結果が変わらないため即座に次の段へ移る。
 */
import { requestOpenAI, requestXai, ProviderHttpError, type Provider } from "./providers.js";
import type { OpenAiOptions, XaiOptions } from "./providers.js";

export const DEFAULT_SAFE_SUFFIX =
  " Depict only the empty location itself with no people and no creature present, just the quiet deserted setting.";

export interface GenerateOptions extends OpenAiOptions, XaiOptions {
  openaiApiKey: string;
  /** 未指定なら xAI フォールバックを行わない */
  xaiApiKey?: string;
  /** xAI フォールバック自体を無効にする（既定 true = 鍵があれば使う） */
  allowFallback?: boolean;
  /** 両提供元に拒否されたときに追記する安全側の文言 */
  safeSuffix?: string;
}

export interface GenerateResult {
  image: Buffer;
  /** 実際に画像を返した提供元 */
  provider: Provider;
  /** 安全版（主題を消した文）で救済された場合 true */
  degraded: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type StepOutcome =
  | { ok: true; image: Buffer }
  | { ok: false; reason: string };

async function requestWithRetry(provider: Provider, fn: () => Promise<Buffer>): Promise<StepOutcome> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { ok: true, image: await fn() };
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        if (err.status === 400) {
          // 内容が弾かれている。同じ文で粘らず次の手へ移る
          return { ok: false, reason: `${provider} HTTP 400 ${err.detail}` };
        }
        if (attempt === 2) {
          return { ok: false, reason: `${provider} HTTP ${err.status} ${err.detail}` };
        }
      } else if (attempt === 2) {
        return { ok: false, reason: `${provider} ${err instanceof Error ? err.message : String(err)}` };
      }
      // 429 と 5xx はすぐ叩き直しても同じ結果になりやすいので指数で待つ
      await sleep(4000 * 2 ** attempt);
    }
  }
  return { ok: false, reason: `${provider} unreachable` };
}

interface Step {
  provider: Provider;
  prompt: string;
  degraded: boolean;
}

export async function generateImage(prompt: string, opts: GenerateOptions): Promise<GenerateResult> {
  const safeSuffix = opts.safeSuffix ?? DEFAULT_SAFE_SUFFIX;
  // 既定は OpenAI 内で完結させる（安全版への切り替えのみ）。xAI へのクロスプロバイダ
  // フォールバックは、呼び出し側が allowFallback=true を明示したときだけ使う
  const useFallback = (opts.allowFallback ?? false) && !!opts.xaiApiKey;

  const plan: Step[] = [
    { provider: "openai", prompt, degraded: false },
    ...(useFallback ? [{ provider: "xai" as const, prompt, degraded: false }] : []),
    { provider: "openai", prompt: `${prompt}${safeSuffix}`, degraded: true },
  ];

  const failures: string[] = [];
  for (const step of plan) {
    const run = () =>
      step.provider === "openai"
        ? requestOpenAI(step.prompt, opts.openaiApiKey, { size: opts.size, quality: opts.quality })
        : requestXai(step.prompt, opts.xaiApiKey as string, {
            aspectRatio: opts.aspectRatio,
            resolution: opts.resolution,
          });

    const outcome = await requestWithRetry(step.provider, run);
    if (outcome.ok) {
      return { image: outcome.image, provider: step.provider, degraded: step.degraded };
    }
    failures.push(outcome.reason);
  }

  throw new Error(`全ての生成手段が失敗しました: ${failures.join(" / ")}`);
}
