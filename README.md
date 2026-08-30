# Yonde

Yonde（読んで）是一个配置驱动的 Bun CLI：把日文文本翻译成逐句对照的双语听力稿，再通过 Edge TTS 与 ffmpeg 合成为可自定义朗读顺序的 MP3。

## 快速开始

需要 [Bun](https://bun.sh/) 1.3 或更新版本。生成 MP3 时还需要 `ffmpeg`；只运行翻译阶段则不需要。

```bash
bunx @makuraryu/yonde@latest init

# 默认配置从这个环境变量读取 DeepSeek API Key
export YONDE_API_KEY="your-api-key"

bunx @makuraryu/yonde@latest input.txt
```

`bunx` 会从 npm 获取最新版并直接运行，无需全局安装。也可以使用 `bunx github:Makuraryu/Yonde` 试用 GitHub 默认分支上的未发布代码。版本记录见 [GitHub Releases](https://github.com/Makuraryu/Yonde/releases)。

## 命令

```text
yonde <输入.txt> [选项]
yonde init [配置文件]
yonde config check [--config <配置文件>]
```

常用示例：

```bash
# 翻译并生成音频
bunx @makuraryu/yonde@latest input.txt

# 只翻译，或使用已有翻译生成音频
bunx @makuraryu/yonde@latest input.txt --stage translate
bunx @makuraryu/yonde@latest input.txt --stage audio

# 指定配置和输出目录
bunx @makuraryu/yonde@latest input.txt --config ./custom.toml --output-dir ./build

# 检查最终合并后的配置
bunx @makuraryu/yonde@latest config check
bunx @makuraryu/yonde@latest config check --config ./custom.toml

# 查看完整帮助
bunx @makuraryu/yonde@latest --help
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
| `YONDE_API_ENDPOINT` | 覆盖翻译 API 地址 |
| `YONDE_MODEL` | 覆盖模型 |
| `YONDE_TTS_CONCURRENCY` | 覆盖 TTS 并发数 |

也可以用 `translation.api.api_key_env` 明确指定一个 API Key 环境变量。若 TOML 中直接设置了 `translation.api.api_key`，它优先于环境变量；未设置时只读取 `api_key_env` 指定的变量（默认 `YONDE_API_KEY`）。Yonde 不会隐式读取 `DEEPSEEK_API_KEY` 或任何其他 Key 变量。Yonde 会提示检查含明文 Key 的文件权限。API Key 不会写入检查点、日志或音频清单。

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

缓存文件采用原子写入；命中缓存时只检查文件元数据，避免 iCloud 为数千个小文件执行随机头部读取。最终拼接再按朗读顺序连续读取音频内容。

翻译、语音生成和最终 MP3 合并都会显示单行进度条，包括完成比例、数量、耗时和 ETA。非交互终端按 5% 里程碑输出，避免日志刷屏。

如果模型把一个输入句子的译文错误拆成多项，Yonde 会先带着数量校验错误进行严格重试；仍不符合时，仅对单句结果执行顺序合并，避免检查点永久卡在同一段。

若目标译文片段只含日文假名，而目标语言音色无法生成音频，Yonde 会自动借用配置中的日文音色，并保留目标 profile 的语速和音调。缓存指纹会记录实际使用的音色。

所有语音和分隔音效会统一为 24 kHz、单声道、96 kbps，最终 MP3 采用无损快速拼接，不再把数小时音频完整重编码。合并中的大临时文件写在本机临时目录，完成后再一次性写入目标位置，避免 iCloud 持续同步一个不断增长的文件。

最终合并使用状态文件保护原子写入。若进程在 ffmpeg 已完成后、最终重命名前退出，下次运行会直接恢复成品；若在合并中途退出，只会重做最终合并，已经生成的翻译和 TTS 缓存不会丢失。

## 本地开发

```bash
git clone https://github.com/Makuraryu/Yonde.git
cd Yonde
bun install
bun test
bun run check
bun run src/main.ts --help
```

## npm 发布

```bash
bun run check
bun test
npm pack --dry-run
npm publish --access public
```

发布后可通过 `bunx @makuraryu/yonde@latest` 直接运行；GitHub 包标识适合测试尚未发布的默认分支。

## License

[MIT](./LICENSE)
