# Inkrelay MCP

情景（英語のシーン記述）から画像を生成する MCP サーバー。OpenAI `gpt-image-2` を主力に、
安全フィルタで拒否されたときは安全側の文で同じ提供元へ再挑戦する。`allowFallback: true` を
明示したときだけ、その前に xAI `grok-imagine-image` へ同文でフォールバックする（既定オフ）。
生成時に生じやすい単色の枠を検出して落とす後処理と、意図どおりに伝わる情景文を書くための
ガイドツールも備える。

## できること

| ツール | すること |
| --- | --- |
| `generate_image` | 情景文から画像を 1 枚生成して保存する。安全フィルタに拒否されたときは安全側の文で再挑戦する（`allowFallback: true` なら先に xAI も試す） |
| `retrim_image` | 生成済み画像から単色の枠だけを検出して落とす（API を呼ばないので無料） |
| `prompt_writing_guide` | 画像生成モデルに指示が正しく伝わる情景文の書き方を、実測に基づく規則集として返す |

## インストール

```bash
git clone https://github.com/1llum1n4t1s/inkrelay-mcp.git
cd inkrelay-mcp
pnpm install
pnpm build
```

## Claude Code への登録

APIキーは [OpenAI](https://platform.openai.com/api-keys)（必須）と
[xAI](https://console.x.ai/)（任意、フォールバック用）からそれぞれ取得する。ユーザースコープで
登録すると、どのプロジェクトの会話からも呼び出せる。`<repo>` は clone したディレクトリの絶対パス
に置き換える。

```bash
claude mcp add inkrelay -s user --env OPENAI_API_KEY=<your-openai-api-key> --env XAI_API_KEY=<your-xai-api-key> -- node <repo>/dist/index.js
```

xAI キーが無い場合は `--env XAI_API_KEY=...` の指定ごと省略してよい（`generate_image` の
`allowFallback: true` を使わない限り、xAI キーの有無は動作に影響しない）。

登録状態は `claude mcp list` で確認できる。鍵はユーザースコープ設定ファイル（このリポジトリの
外）に保存され、git管理下には入らない。コマンドをシェル履歴に残したくない場合は、環境変数へ
一時的に読み込んでから `--env OPENAI_API_KEY=$OPENAI_API_KEY`（PowerShell なら
`$env:OPENAI_API_KEY`）のように参照渡しする。

既定（`allowFallback` 未指定）では xAI キーの有無にかかわらず xAI へは回さず、OpenAI が拒否した
題材は安全側の文（主題を消して舞台だけにする）へ自動で切り替わる。結果に `degraded: true` として
残るので、その場合は絵に主題が写っていない前提で確認すること。xAI キーを設定したうえで
`generate_image` に `allowFallback: true` を渡すと、安全版を試す前に xAI へ同文でフォールバック
するようになる（提供元によって安全フィルタの当たり所が違うため、主題が残る可能性が上がる）。

## 使い方

会話の中で「〜の挿絵を生成して」のように頼むと `generate_image` が呼ばれる。良い結果を得るには、
生成前に `prompt_writing_guide` の内容に沿って情景文を組み立てるとよい。要点だけ挙げると:

- 舞台・対象は名前からの推測に頼らず、確定した情報で書く
- 人物が複数出るなら全員に性別・年齢層を書く（一部だけ書くと、書かれなかった人物が既定の姿で描かれる）
- 大きさの異常は「通常の大きさの人間」を基準にして書く（器物を基準にすると器物側が変形する）
- 「〜が無い」ではなく、実際にある状態を書く（否定形は効かないか、逆に描かれる）

画風・技法・色調を固定したい場合は、呼び出しごとに `prompt` の先頭へスタイル指定を付ける
（情景の描写とスタイル指定が混ざると、生成のたびに絵柄がばらつく）。

## 料金の目安

OpenAI `gpt-image-2` の `quality: low`（既定）で 1 枚 $0.005。`medium` / `high` は、
配信サイズへ縮小して使うなら見た目の差がほとんど出ないため、既定を上げる前に実際に必要か
確認する。xAI `grok-imagine-image` のフォールバックは 1 枚 $0.02。

## トラブルシュート

| 症状 | 原因 |
| --- | --- |
| `OPENAI_API_KEY が未設定です` というエラーで失敗する | 環境変数が渡っていない。`claude mcp list` で登録状態を確認する |
| 結果が `degraded: true` で返る | 両提供元に拒否された。情景文の題材が安全フィルタに触れている可能性が高い |
| 生成した画像の四辺に単色の余白が残る | `generate_image` の呼び出しで `trim: true` を指定していない、または枠の明度が既定の検出条件の外にある（`retrim_image` を後から呼んでも直らない場合、閾値が合っていない） |
