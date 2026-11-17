# YT Transcribe

A local web app that turns a YouTube URL into a clean, copy/pasteable markdown transcript. It reads the video's own caption track, so nothing is downloaded, and can optionally polish the text with a local LLM.

## Run

Requires Node 18+. No dependencies to install.

```bash
node server.js
```

Open http://localhost:3000, paste a YouTube link, and click **Transcribe**.

## Command line

Get a markdown file straight from a URL, no browser needed:

```bash
node cli.js https://youtu.be/jNQXAC9IVRw          # writes Me-at-the-zoo.md in the current folder
node cli.js <url> -q -t -o notes.md               # quick cleanup + timestamps, custom file name
node cli.js <url> --stdout > transcript.md        # print instead of writing a file
node cli.js <url> --langs                         # list available caption languages
```

To use it as a `yt-transcribe` command anywhere, run `npm link` once in this folder.

Like the web app, it makes no AI calls unless you ask. Options:

| Option | What it does |
| --- | --- |
| `-o, --output <file>` | Write to this file (overwrites). `-` means stdout. By default the file is named after the video title and never overwrites an existing file. |
| `--stdout` | Print the markdown instead of writing a file |
| `-t, --timestamps` | Add `[mm:ss]` timestamps to each paragraph |
| `-l, --lang <code>` | Caption language (default: best English track) |
| `-q, --quick` | Remove ums, ahs, `[Music]` tags and stutters (no AI) |
| `--ai --model <name>` | AI polish with an Ollama model |
| `--ai --endpoint <url> --model <name>` | AI polish with any OpenAI-compatible server (base URL such as `http://127.0.0.1:8888/v1`) |
| `--key <key>` | API key for the endpoint. Safer: set the `YT_TRANSCRIBE_KEY` environment variable |
| `--free` | AI polish with the free keyless public model (text is sent to pollinations.ai) |
| `--whole` | Send the whole transcript in one request instead of chunks |

Progress and warnings go to stderr, so `--stdout` output stays clean for piping. The exit code is non-zero on errors.

## How it works

1. **Fetch**: the local server asks YouTube for the video's caption track (manual or auto-generated) and parses it into timed lines. No audio or video is downloaded.
2. **Clean up** (all optional; by default the captions are converted to markdown as-is, with no AI):
   - **Remove ums, ahs & repeats**: a checkbox for instant rule-based cleanup in the browser. Removes um/uh/ah/er/hmm and `[Music]` tags, collapses stutters, fixes spacing and capitalization.
   - **AI polish**: a button that opens a panel. Turn it on, pick a model, and the text is sent to it to remove filler and false starts, keep the corrected wording, fix mis-heard words, and add punctuation and sentence breaks. You can send it in chunks or as one whole transcript.
3. **Output**: markdown with title, channel, source link and caption language, with optional timestamps. Copy it or download a `.md` file.

## AI polish backends

In the AI polish panel, the model dropdown lists chat models from whichever of these is running. You can also paste your own OpenAI-compatible endpoint URL (including a cloud one) under **Custom API endpoint**, or use the one-click free public preset (text is sent to a third-party service):

| Backend | Default address | Override | Auth |
| --- | --- | --- | --- |
| oMLX (OpenAI-compatible) | `http://127.0.0.1:8888` | `OMLX_HOST` | API key, entered in the page or set as `OMLX_API_KEY` |
| Ollama | `http://127.0.0.1:11434` | `OLLAMA_HOST` | none |

A key entered in the page is stored only in that browser's local storage and is sent to your local server, which forwards it to oMLX. Embedding models are hidden from the list.

Other settings: `PORT` changes the server port (default 3000).

## Limitations

- **Captions only.** The polish works on caption text and never hears the audio, so words YouTube's captions got wrong or dropped can't be recovered. Videos with no caption track return an error.
- **Unofficial YouTube access.** Captions are fetched through YouTube's internal player API, which is unofficial and may change or be blocked. If it breaks, start with the `CLIENTS` list in `server.js`.
- **Model quality varies.** A first AI polish can be slow while the model loads. Small models may occasionally rephrase more than intended.

## Files

- `server.js`: HTTP server, caption fetching and parsing, model proxy.
- `cli.js`: command-line interface.
- `public/index.html`: the web UI.
- `public/format.js`: cleanup rules and markdown building, shared by the web UI and the CLI.
