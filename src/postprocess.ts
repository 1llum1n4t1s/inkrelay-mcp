/**
 * 生成画像の後処理。どちらも既定オフで、呼び出し側が明示的に指定したときだけ動く。
 *
 * trimBorder() は urban_legend/tools/images.py の trim_border() を移植したもの。
 * 画像生成モデルが版画の余白のような単色の枠を描いてしまうことがあり、
 * 文言でいくら「枠を描くな」と指示しても無視され続けるため、機械的に検出して落とす。
 * 閾値の既定値は新版画風での実測に基づくので、別の画風で使うときは
 * BorderTrimOptions で上書きする（明るい単色背景の絵を誤って削らないよう、
 * 極端に緩めない方がよい）。
 */
import sharp from "sharp";

export const DEFAULT_BORDER_TOLERANCE = 14;
export const DEFAULT_BORDER_CONTRAST = 45;
export const DEFAULT_BORDER_MIN_PAPER = 150;
export const DEFAULT_BORDER_MAX_SPREAD = 60;
export const DEFAULT_BORDER_MAX_RATIO = 0.18;

export interface BorderTrimOptions {
  /** 枠の色から何段離れたら「絵が始まった」とみなすか */
  tolerance?: number;
  /** 枠とみなすために必要な、枠と中央の明度差の下限 */
  contrast?: number;
  /** 枠は白い紙なので必ず明るい。この値未満なら枠ではなく絵の一部と判定する */
  minPaper?: number;
  /** 4 辺の明度差の上限。これを超えたら枠ではないと判定する */
  maxSpread?: number;
  /** 1 辺あたりに削ってよい最大幅（画像幅 or 高さに対する比率） */
  maxRatio?: number;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function detectBorder(
  gray: Buffer,
  width: number,
  height: number,
  opts: Required<BorderTrimOptions>,
): Box | null {
  const rowStep = Math.max(1, Math.floor(width / 120));
  const colStep = Math.max(1, Math.floor(height / 120));

  const row = (y: number): number => {
    const values: number[] = [];
    for (let x = 0; x < width; x += rowStep) values.push(gray[y * width + x]);
    return median(values);
  };
  const col = (x: number): number => {
    const values: number[] = [];
    for (let y = 0; y < height; y += colStep) values.push(gray[y * width + x]);
    return median(values);
  };

  const sides = [col(0), col(width - 1), row(0), row(height - 1)];
  const paper = sides.reduce((a, b) => a + b, 0) / 4;
  const center = row(Math.floor(height / 2));

  // 枠でないと確信できる条件が 1 つでも成立したら、何もせず抜ける
  if (Math.min(...sides) < opts.minPaper) return null;
  if (Math.max(...sides) - Math.min(...sides) > opts.maxSpread) return null;
  if (paper - center < opts.contrast) return null;

  const scan = (read: (i: number) => number, limit: number): number => {
    for (let i = 0; i < limit; i++) {
      if (Math.abs(read(i) - paper) > opts.tolerance) return i;
    }
    return 0;
  };

  const xmax = Math.floor(width * opts.maxRatio);
  const ymax = Math.floor(height * opts.maxRatio);
  const left = scan((i) => col(i), xmax);
  const right = scan((i) => col(width - 1 - i), xmax);
  const top = scan((i) => row(i), ymax);
  const bottom = scan((i) => row(height - 1 - i), ymax);

  if (!left && !right && !top && !bottom) return null;

  // 縁のアンチエイリアスが 1px 残ると細い明線として目立つので余分に削る
  const pad = 2;
  return {
    left: Math.min(left + pad, xmax),
    top: Math.min(top + pad, ymax),
    right: Math.min(right + pad, xmax),
    bottom: Math.min(bottom + pad, ymax),
  };
}

/** 版画の余白として描かれた明色の枠を落とす。枠が無ければ元の画像をそのまま返す。 */
export async function trimBorder(
  image: Buffer,
  opts: BorderTrimOptions = {},
): Promise<{ image: Buffer; trimmed: boolean }> {
  const resolved: Required<BorderTrimOptions> = {
    tolerance: opts.tolerance ?? DEFAULT_BORDER_TOLERANCE,
    contrast: opts.contrast ?? DEFAULT_BORDER_CONTRAST,
    minPaper: opts.minPaper ?? DEFAULT_BORDER_MIN_PAPER,
    maxSpread: opts.maxSpread ?? DEFAULT_BORDER_MAX_SPREAD,
    maxRatio: opts.maxRatio ?? DEFAULT_BORDER_MAX_RATIO,
  };

  const { data, info } = await sharp(image)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const box = detectBorder(data, info.width, info.height, resolved);
  if (!box) return { image, trimmed: false };

  const cropped = await sharp(image)
    .extract({
      left: box.left,
      top: box.top,
      width: info.width - box.left - box.right,
      height: info.height - box.top - box.bottom,
    })
    .toBuffer();
  return { image: cropped, trimmed: true };
}

export interface EncodeOptions {
  format?: "webp" | "png" | "jpeg";
  quality?: number;
  /** 指定した幅へ縮小する。原寸より大きい値を渡しても拡大はしない */
  outWidth?: number;
}

/** 任意の幅へリサイズし、指定フォーマットへ変換する。省略時は原寸 PNG のまま返す */
export async function encodeImage(image: Buffer, opts: EncodeOptions = {}): Promise<Buffer> {
  let pipeline = sharp(image);
  if (opts.outWidth) {
    pipeline = pipeline.resize({ width: opts.outWidth, withoutEnlargement: true });
  }
  switch (opts.format) {
    case "webp":
      return pipeline.webp({ quality: opts.quality ?? 82 }).toBuffer();
    case "jpeg":
      return pipeline.jpeg({ quality: opts.quality ?? 90 }).toBuffer();
    case "png":
    default:
      return pipeline.png().toBuffer();
  }
}
