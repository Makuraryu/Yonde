# Yonde

Yonde（読んで）是一个配置驱动的 Bun CLI：把日文文本翻译成逐句对照的双语听力稿，再通过 Edge TTS 与 ffmpeg 合成为可自定义朗读顺序的 MP3。

## 快速开始

需要 [Bun](https://bun.sh/) 1.3 或更新版本。生成 MP3 时还需要 `ffmpeg`；只运行翻译阶段则不需要。

```bash
bunx github:Makuraryu/Yonde init

# 默认配置从这个环境变量读取 DeepSeek API Key
export YONDE_API_KEY="your-api-key"

bunx github:Makuraryu/Yonde input.txt
```

这会直接从公开 GitHub 仓库的默认分支安装并运行，不需要 npm 发布。版本记录可在 [GitHub Releases](https://github.com/Makuraryu/Yonde/releases) 查看。

## 命令

```text
yonde <输入.txt> [选项]
yonde init [配置文件]
yonde config check [--config <配置文件>]
```

常用示例：

```bash
# 翻译并生成音频
bunx github:Makuraryu/Yonde input.txt

# 只翻译，或使用已有翻译生成音频
bunx github:Makuraryu/Yonde input.txt --stage translate
bunx github:Makuraryu/Yonde input.txt --stage audio

# 指定配置和输出目录
bunx github:Makuraryu/Yonde input.txt --config ./custom.toml --output-dir ./build

# 检查最终合并后的配置
bunx github:Makuraryu/Yonde config check
bunx github:Makuraryu/Yonde config check --config ./custom.toml

# 查看完整帮助
bunx github:Makuraryu/Yonde --help
```

`init` 默认创建 `./yonde.toml`，且不会覆盖已有文件。

## 配置发现与优先级

高优先级覆盖低优先级：

1. CLI 参数，例如 `--config`、`--output-dir`、`--stage`
2. 环境变量
3. `--config` 指定的 TOML
4. 当前目录的 `yonde.toml`
5. `~/.config/yonde/config.toml`
6. 内置默认值

Yonde 支持以下环境变量：

| 变量 | 用途 |
| --- | --- |
| `YONDE_API_KEY` | 默认翻译 API Key |
| `DEEPSEEK_API_KEY` | API Key 兼容变量 |
| `YONDE_API_ENDPOINT` | 覆盖翻译 API 地址 |
| `DEEPSEEK_BASE_URL` | API 基础地址兼容变量 |
| `YONDE_MODEL` / `DEEPSEEK_MODEL` | 覆盖模型 |
| `YONDE_TTS_CONCURRENCY` | 覆盖 TTS 并发数 |

也可以用 `translation.api.api_key_env` 指定任意 API Key 环境变量。若 TOML 中直接设置了 `translation.api.api_key`，它会优先于所有环境变量；未设置时才读取 `api_key_env`、`YONDE_API_KEY` 和兼容变量。Yonde 会提示检查含明文 Key 的文件权限。API Key 不会写入检查点、日志或音频清单。

## TOML 配置

运行 `yonde init` 会生成带全部默认值的模板。主要结构如下：

```toml
version = 1

[translation]
source_language = "ja"
target_language = "zh-Hans"
context_paragraphs = 6
batch_size = 12
temperature = 0.2

[translation.api]
endpoint = "https://api.deepseek.com/chat/completions"
model = "deepseek-chat"
api_key_env = "YONDE_API_KEY"
timeout_ms = 120000

[text]
sentence_endings = ["。", "、", "！", "？"]

[audio]
concurrency = 8
max_chunk_chars = 380
paragraph_sequence = ["source_full", "sentences", "separator"]
sentence_sequence = ["source_slow", "target_normal", "source_repeat"]

[audio.profiles.source_full]
text = "source"
voice = "ja-JP-KeitaNeural"
language = "ja-JP"
rate = "+0%"
pitch = "-5%"

[audio.profiles.source_slow]
text = "source"
voice = "ja-JP-KeitaNeural"
language = "ja-JP"
rate = "-20%"
pitch = "-5%"

[audio.profiles.target_normal]
text = "target"
voice = "zh-CN-YunxiNeural"
language = "zh-CN"
rate = "+0%"
pitch = "+0Hz"

[audio.profiles.source_repeat]
text = "source"
voice = "ja-JP-NanamiNeural"
language = "ja-JP"
rate = "+0%"
pitch = "+0Hz"

[audio.separator]
enabled = true
package_asset = "uisfx/sounds/cinematic/select.mp3"
```

`paragraph_sequence` 可引用任意 profile，以及特殊项 `sentences` 和 `separator`。`sentence_sequence` 可重复引用同一 profile，例如 `["source_slow", "source_slow", "target_normal"]` 就会把慢速源文读两遍。profile 的 `text` 可选 `source` 或 `target`，因此翻译语言与语音可以独立配置。

默认顺序是：每段源文全文 → 每句源文慢速、译文正常、源文复读 → 段落分隔音。

## 输出与缓存

默认输出到输入文件旁的 `output/`：

- `<文件名>.listening.txt`：逐句双语听力稿
- `<文件名>.listening.mp3`：合成音频
- `.state/.../translation.json`：翻译检查点和动态术语表
- `.state/.../audio-cache/`：TTS 片段缓存
- `.state/.../audio-manifest.json`：实际音色、顺序和片段清单

翻译缓存指纹包含输入内容、语言、模型、端点、提示词版本和分句规则，但不包含 API Key。音频缓存指纹包含文本、音色、语言、语速和音调。仅调整朗读顺序时，Yonde 会复用已有语音并重新合并。

## 本地开发

```bash
git clone https://github.com/Makuraryu/Yonde.git
cd Yonde
bun install
bun test
bun run check
bun run src/main.ts --help
```

## npm 发布（可选）

```bash
bun run check
bun test
npm pack --dry-run
npm publish --access public
```

Yonde 不依赖 npm 发布即可通过上面的 `github:Makuraryu/Yonde` 包标识运行。npm 发布只是提供更短的 registry 包名。

## License

[MIT](./LICENSE)
