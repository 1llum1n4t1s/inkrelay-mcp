#!/usr/bin/env node
/**
 * Inkrelay MCP — 情景文（英語のシーン記述）から挿絵を生成する MCP サーバ。
 * urban_legend/tools/images.py で磨いた知見（提供元をまたぐフォールバック、
 * 版画風の枠検出、プロンプトの書き方）を汎用化して切り出したもの。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DEFAULT_SAFE_SUFFIX, generateImage } from "./generate.js";
import { encodeImage, trimBorder } from "./postprocess.js";

const server = new McpServer({
  name: "inkrelay",
  version: "0.1.0",
});

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: `エラー: ${message}` }],
    isError: true,
  };
}

async function guard<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function requireOpenAiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY が未設定です。MCP サーバー起動時の環境変数として渡してください。");
  }
  return key;
}

// ---------------------------------------------------------------------------
// 1. generate_image — 情景文から画像を 1 枚生成して保存する
// ---------------------------------------------------------------------------
server.registerTool(
  "generate_image",
  {
    title: "画像を生成する",
    description:
      "英語の情景文（シーン記述）から画像を 1 枚生成し、指定パスへ保存する。" +
      "本命は OpenAI gpt-image-2。安全フィルタに拒否された場合、既定では safeSuffix を追記した" +
      "安全側の文で同じ提供元へ最後の 1 回だけ再挑戦し、成功しても degraded=true として返す" +
      "（主題が画面から消えている可能性が高いので確認が要る）。" +
      "allowFallback=true かつ XAI_API_KEY が設定されている場合に限り、安全版を試す前に" +
      "同じ文のまま xAI grok-imagine-image へ 1 回フォールバックする" +
      "（提供元によって安全フィルタの当たり所が違うため、文を弱める前に提供元を替える方が" +
      "主題が残りやすいことがある）。" +
      "良いプロンプトの書き方に迷ったら、先に prompt_writing_guide を呼ぶこと。",
    inputSchema: {
      prompt: z
        .string()
        .describe(
          "描かせる内容の英語の記述。画風・技法・色調を固定したい場合は呼び出し側で先頭に付けて渡す" +
            "（情景の描写とスタイル指定を混在させると項目ごとに絵柄がばらつきやすい）",
        ),
      outPath: z.string().describe("保存先の絶対パス"),
      size: z
        .enum(["1024x1024", "1536x1024", "1024x1536"])
        .optional()
        .describe("OpenAI 用の画角。正方形 / 横長（既定） / 縦長"),
      quality: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("OpenAI 用の画質（既定 low=$0.005/枚）。配信サイズへ縮小するなら上げても見た目は変わらないことが多い"),
      trim: z
        .boolean()
        .optional()
        .describe("単色の枠（版画の余白のような縁）を検出して機械的に落とす（既定 false）"),
      outWidth: z.number().int().positive().optional().describe("この幅へ縮小する（既定は原寸のまま）"),
      format: z.enum(["webp", "png", "jpeg"]).optional().describe("保存形式（既定 png）"),
      formatQuality: z.number().int().min(1).max(100).optional().describe("webp/jpeg のエンコード品質"),
      allowFallback: z
        .boolean()
        .optional()
        .describe(
          "true にすると、XAI_API_KEY が設定されている場合に限り、拒否時に xAI へ同文でフォールバックしてから安全版を試す（既定 false = OpenAI 内の安全版のみで完結する）",
        ),
      safeSuffix: z
        .string()
        .optional()
        .describe(
          `両提供元に拒否されたときに追記する安全側の文言（既定は主題を消して舞台だけにする定型文: "${DEFAULT_SAFE_SUFFIX.trim()}"）`,
        ),
    },
  },
  async ({ prompt, outPath, size, quality, trim, outWidth, format, formatQuality, allowFallback, safeSuffix }) =>
    guard(async () => {
      const openaiApiKey = requireOpenAiKey();
      const xaiApiKey = process.env.XAI_API_KEY;

      const result = await generateImage(prompt, {
        openaiApiKey,
        xaiApiKey,
        size,
        quality,
        allowFallback,
        safeSuffix,
      });

      let image = result.image;
      let trimmed = false;
      if (trim) {
        const trimResult = await trimBorder(image);
        image = trimResult.image;
        trimmed = trimResult.trimmed;
      }
      if (outWidth || format) {
        image = await encodeImage(image, { outWidth, format, quality: formatQuality });
      }

      const dest = path.resolve(outPath);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, image);

      return {
        path: dest,
        provider: result.provider,
        degraded: result.degraded,
        trimmed,
        bytes: image.length,
        hint: result.degraded
          ? "degraded=true: 両提供元に拒否され、主題を消した安全側の文で救済しました。絵に主題が写っていない可能性が高いので目視確認してください。"
          : undefined,
      };
    }),
);

// ---------------------------------------------------------------------------
// 2. retrim_image — 生成済み画像の枠だけを後から落とす（API を呼ばない）
// ---------------------------------------------------------------------------
server.registerTool(
  "retrim_image",
  {
    title: "生成済み画像の枠を検出して落とす",
    description:
      "既存の画像ファイルから、単色の枠（版画の余白のような縁）だけを検出して落とす。" +
      "API を呼ばないため無料。枠が検出されなければファイルには触れない。",
    inputSchema: {
      path: z.string().describe("対象画像の絶対パス"),
    },
  },
  async ({ path: targetPath }) =>
    guard(async () => {
      const dest = path.resolve(targetPath);
      const original = await readFile(dest);
      const { image, trimmed } = await trimBorder(original);
      if (trimmed) {
        await writeFile(dest, image);
      }
      return { path: dest, trimmed };
    }),
);

// ---------------------------------------------------------------------------
// 3. prompt_writing_guide — 情景文の書き方ノウハウ
// ---------------------------------------------------------------------------
const PROMPT_GUIDE = {
  principle:
    "画像生成モデルは指示された関係や語をそのまま満たそうとするので、曖昧・否定形・暗黙の前提は" +
    "予想外の形で解決される。実測で繰り返し踏んだ失敗パターンとその対策を以下に示す。",
  rules: [
    {
      rule: "対象の実体は確定情報から書く。名前から推測しない",
      why: "固有名詞は場所や由来を暗示するが誤読しやすい（例: 人名が地名のように見える）。取り違えると絵が丸ごと別物になり、しかも破綻なく描けてしまうため気づけない。",
    },
    {
      rule: "何が異常／特徴的なのかを 1 文目に明記する",
      why: "焦点がぼやけると、モデルは平凡な情景に寄せる。読み手が絵から特徴を読み取れて初めて挿絵の意味がある。",
    },
    {
      rule: "人物が出てくる場面は、登場人物全員に性別と年齢層を明記する",
      why: "ローマ字の固有名詞は性別の手がかりにならず、既定で成人男性に流れる。一部の人物にだけ書くのが最も危険（他は書かれているのに 1 人だけ抜けると、その 1 人だけ誤って描かれる）。この失敗は文面の検査では取れない（性別語自体は文中にあるため）ので、生成後に画像を目視して確認する。",
    },
    {
      rule: "建物・器物は種別・作り・姿勢まで具体的に書く",
      why: "「櫓」だけでは汎用形（鐘楼型）に、姿勢を書かなければ不自然な配置に流れる。",
    },
    {
      rule: "対象を隠す構図（遠景・シルエット・後ろ姿）を指示しない。近景に大きくはっきり置く",
      why: "怖さや雰囲気を構図で作ろうとすると、決め手となる特徴が読み取れない絵になる。静けさは色調や光で作り、姿を決める特徴は近景に置く。",
    },
    {
      rule: "特徴は幾何学的な表現や比較対象で書く",
      why: "「逆向きの足」ではなく「かかとが前を向き、つま先が後ろを向く」。「小人」ではなく「地面の家具より背が低い」。抽象語のままだと描き分けられず普通の姿に流れる。",
    },
    {
      rule: "否定形（〜が無い）を書かない。ある状態を書く",
      why: "否定形は効かないどころか、その語だけが拾われて逆に描かれることがある（「顔が無い」ではなく「のっぺりとした肌だけの平らな面」と書く）。",
    },
    {
      rule: "比喩の色を絶対色に訳さない。bright/vivid/pure を肌や体の色に付けない",
      why: "「〜のように赤い」のような程度・質感の比喩を絶対色として書くと原色でべた塗りされる。血色の良さなら「肌色を保ったまま赤みを帯びている」のように書く。本文が色そのものを述べている場合（例: 全身が赤い肌をさらしている）はそのまま色名でよい。",
    },
    {
      rule: "大きさの異常は必ず通常の大きさの人間を基準にして書く",
      why: "器物を基準にすると、器物側が伸縮して関係を満たしてしまう（「灯籠に対して膝の高さ」と書いたら、人物ではなく灯籠が数階建てになった実測例がある）。人間の大きさだけは見る側が動かせない基準として機能する。",
    },
    {
      rule: "周囲の情景は、同じ視点から実際に見える範囲だけを書く",
      why: "壁の向こうの別空間まで書くと、モデルは両方を 1 枚に収めようとして壁を消し、断面図のような破綻した絵になる。窓や開いた戸の先に見える外観は同一視点で成立するので書いてよい。",
    },
    {
      rule: "画風・技法・色調は固定スタイルとしてまとめ、情景の描写には混ぜない",
      why: "情景文ごとに画風がばらつく。スタイル指定と情景描写を分離すると、大量生成しても質感が揃う。",
    },
  ],
  operational: [
    "生成が拒否されたら、まず表現を弱めるのではなく提供元を替えることを検討する（安全フィルタの当たり所は提供元ごとに違う）。generate_image は既定でこれを自動化している。",
    "画像を目視で確認できる場合、特に人物が複数出る場面は必ず確認する（性別・年齢の誤りは文面検査では捕まらない）。",
    "同じ情景文を再周回しても改善は頭打ちになりやすい。1〜2 回書き直して直らない特徴は、モデル側の限界として諦める判断も要る。",
  ],
};

server.registerTool(
  "prompt_writing_guide",
  {
    title: "情景文（画像生成プロンプト）の書き方ガイド",
    description:
      "画像生成モデルに指示が正しく伝わる情景文を書くための、実測に基づく規則集を返す。" +
      "生成結果が意図と食い違う、人物の性別が逆になる、大きさの関係が壊れる、枠や余白が写り込む、" +
      "といった問題に心当たりがあるとき、プロンプトを書く前に呼ぶ。",
    inputSchema: {},
  },
  async () => guard(async () => PROMPT_GUIDE),
);

const transport = new StdioServerTransport();
await server.connect(transport);
