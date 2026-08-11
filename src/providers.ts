/**
 * 画像生成プロバイダの薄い呼び出し層。
 * 本命は OpenAI gpt-image-2、拒否時のフォールバックが xAI grok-imagine-image。
 * 採用根拠（情景文への指示追従が上・quality low で十分・枠がほぼ出ない）は
 * urban_legend/tools/images.py の A/B 実測に基づく。
 */

export type Provider = "openai" | "xai";

export const OPENAI_MODEL = "gpt-image-2";
export const XAI_MODEL = "grok-imagine-image";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/images/generations";
const XAI_ENDPOINT = "https://api.x.ai/v1/images/generations";

export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: Provider,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`${provider} HTTP ${status}: ${detail}`);
    this.name = "ProviderHttpError";
  }
}

interface ImagesApiResponse {
  data: Array<{ b64_json?: string; url?: string }>;
}

async function postImage(
  provider: Provider,
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
): Promise<{ b64Json?: string; url?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new ProviderHttpError(provider, res.status, detail);
  }
  const json = (await res.json()) as ImagesApiResponse;
  const row = json.data[0];
  return { b64Json: row.b64_json, url: row.url };
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

export interface OpenAiOptions {
  /** 既定 "1536x1024"（3:2）。正方形は "1024x1024"、縦長は "1024x1536" */
  size?: string;
  /** 既定 "low"（$0.005/枚）。配信サイズへ縮める前提なら medium/high へ上げても見た目は変わらない */
  quality?: string;
}

export async function requestOpenAI(
  prompt: string,
  apiKey: string,
  opts: OpenAiOptions = {},
): Promise<Buffer> {
  const row = await postImage(
    "openai",
    OPENAI_ENDPOINT,
    {
      model: OPENAI_MODEL,
      prompt,
      n: 1,
      size: opts.size ?? "1536x1024",
      quality: opts.quality ?? "low",
    },
    apiKey,
  );
  // 既定は b64_json だが、将来 url 返しに変わっても落ちないようにしておく
  if (row.b64Json) return Buffer.from(row.b64Json, "base64");
  if (row.url) return fetchBytes(row.url);
  throw new Error("openai: response has neither b64_json nor url");
}

export interface XaiOptions {
  /** 既定 "3:2"。xAI に size パラメータは無く、送ると 400 になる */
  aspectRatio?: string;
  /** 既定 "1k"。"2k" にすると PNG 6MB 相当が返る（価格は同じ） */
  resolution?: string;
}

export async function requestXai(
  prompt: string,
  apiKey: string,
  opts: XaiOptions = {},
): Promise<Buffer> {
  const row = await postImage(
    "xai",
    XAI_ENDPOINT,
    {
      model: XAI_MODEL,
      prompt,
      n: 1,
      response_format: "b64_json",
      // quality / width / height / seed / output_format は 400 にならず黙って無視される。
      // 効いていると誤解しないよう、対応するパラメータがある aspect_ratio / resolution だけを送る
      aspect_ratio: opts.aspectRatio ?? "3:2",
      resolution: opts.resolution ?? "1k",
    },
    apiKey,
  );
  if (!row.b64Json) throw new Error("xai: response missing b64_json");
  return Buffer.from(row.b64Json, "base64");
}
