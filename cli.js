#!/usr/bin/env node
// YT Transcribe CLI: give it a YouTube URL, get a markdown transcript file.
import { writeFile, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getTranscript, SYSTEM, customBase, stripThink } from './server.js';
import { toBlocks, buildMarkdown, chunk, endsSentence, wordCount } from './public/format.js';

const HELP = `Usage: yt-transcribe <youtube-url-or-id> [options]

Turns a YouTube video's caption track into a markdown file. Nothing is downloaded.
By default the captions are converted as-is, with no AI. The file is written to the
current directory, named after the video title.

Output
  -o, --output <file>     Write to this file (overwrites). Use "-" for stdout.
      --stdout            Print markdown to stdout instead of writing a file.
  -t, --timestamps        Add [mm:ss] timestamps to each paragraph.
  -l, --lang <code>       Caption language code (e.g. en, de). Default: best English.
      --langs             List the caption languages available and exit.

Cleanup (optional)
  -q, --quick             Remove ums/ahs, [Music] tags and stutters (no AI).
      --ai                Polish with an AI model (implies --quick first).
      --model <name>      Model name. Without --endpoint it is an Ollama model.
      --endpoint <url>    OpenAI-compatible base URL, e.g. http://127.0.0.1:8888/v1
      --key <key>         API key for the endpoint. Prefer the YT_TRANSCRIBE_KEY
                          environment variable so the key stays out of shell history.
      --free              Use the free keyless public model (pollinations.ai).
                          Your transcript text is sent to that third-party service.
      --whole             Send the whole transcript in one request instead of chunks.

  -h, --help              Show this help.

Examples
  yt-transcribe https://youtu.be/jNQXAC9IVRw
  yt-transcribe <url> -q -t -o notes.md
  yt-transcribe <url> --ai --endpoint http://127.0.0.1:8888/v1 --model my-model
  yt-transcribe <url> --ai --free
`;

const log = (m) => process.stderr.write(m + '\n');
const die = (m) => { log('Error: ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' }, stdout: { type: 'boolean' },
      timestamps: { type: 'boolean', short: 't' }, lang: { type: 'string', short: 'l' }, langs: { type: 'boolean' },
      quick: { type: 'boolean', short: 'q' }, ai: { type: 'boolean' }, model: { type: 'string' },
      endpoint: { type: 'string' }, key: { type: 'string' }, free: { type: 'boolean' }, whole: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) { die(e.message + '\n\n' + HELP); }
const o = args.values;
if (o.help || !args.positionals.length) { process.stdout.write(HELP); process.exit(0); }
if (args.positionals.length !== 1) die('Give exactly one YouTube URL.\n\n' + HELP);

// ---------- AI backend ----------
function backend() {
  if (o.free) return { endpoint: 'https://text.pollinations.ai/openai', model: 'openai-fast', key: '', custom: true };
  const key = o.key || process.env.YT_TRANSCRIBE_KEY || process.env.OMLX_API_KEY || '';
  if (!o.model) die('--ai needs --model <name> (or --free).');
  if (o.endpoint) return { endpoint: customBase(o.endpoint), model: o.model, key, custom: true };
  return { ollama: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'), model: o.model, custom: false };
}

async function askModel(b, text, label) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }];
  for (let attempt = 0; ; attempt++) {
    let res, j, out, msg;
    try {
      if (b.custom) {
        res = await fetch(b.endpoint + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(b.key ? { Authorization: 'Bearer ' + b.key } : {}) },
          body: JSON.stringify({ model: b.model, messages, stream: false }),
          signal: AbortSignal.timeout(300000),
        });
        j = await res.json().catch(() => ({}));
        out = j.choices?.[0]?.message?.content; msg = j.error?.message;
      } else {
        res = await fetch(b.ollama + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: b.model, stream: false, think: false, options: { temperature: 0.1, num_ctx: 8192 }, messages }),
          signal: AbortSignal.timeout(300000),
        });
        j = await res.json().catch(() => ({}));
        out = j.message?.content; msg = j.error;
      }
    } catch (e) { die(`Could not reach the model (${e.cause?.code || e.message}).`); }
    if (res.ok) return stripThink(out);
    msg = msg || `HTTP ${res.status}`;
    if (attempt < 3 && /rate|limit|retry after|429/i.test(msg + res.status)) {
      const secs = Math.min(+(String(msg).match(/retry after (\d+)\s*s/i) || [])[1] + 2 || 46, 120);
      log(`${label}: rate limited, retrying in ${secs}s…`);
      await sleep(secs * 1000);
      continue;
    }
    die(`Model error: ${msg}`);
  }
}

async function polish(blocks, b) {
  const groups = chunk(blocks, o.whole ? Infinity : b.custom ? 3500 : 1800), result = [];
  let carry = '';
  for (let i = 0; i < groups.length; i++) {
    const label = groups.length === 1 ? 'AI polish' : `AI polish: part ${i + 1} of ${groups.length}`;
    log(label + '…');
    const input = (carry ? carry + ' ' : '') + groups[i].map((x) => x.text).join('\n\n');
    carry = '';
    const parts = (await askModel(b, input, label)).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    if (i < groups.length - 1 && parts.length && !endsSentence(parts.at(-1))) {
      const last = parts.pop();
      const m = [...last.matchAll(/[.!?]["”')\]]*\s+/g)].pop();
      if (m) { parts.push(last.slice(0, m.index + m[0].length).trim()); carry = last.slice(m.index + m[0].length).trim(); }
      else carry = last;
    }
    const t0 = groups[i][0].start, t1 = groups[i].at(-1).start;
    parts.forEach((p, k) => result.push({ start: parts.length > 1 ? t0 + (t1 - t0) * k / (parts.length - 1) : t0, text: p }));
  }
  if (carry) result.push({ start: groups.at(-1).at(-1).start, text: carry });
  return result;
}

// ---------- main ----------
const slug = (t) => t.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'transcript';
async function freeName(base) {
  for (let n = 1; ; n++) {
    const f = n === 1 ? `${base}.md` : `${base}-${n}.md`;
    try { await access(f); } catch { return f; }
  }
}

const ai = o.ai || o.free ? backend() : null; // validate AI options before any network work

let data;
try {
  log('Fetching captions…');
  data = await getTranscript(args.positionals[0], o.lang);
} catch (e) { die(e.message); }

if (o.langs) {
  for (const t of data.tracks) console.log(`${t.code}\t${t.name}${t.auto ? ' (auto-generated)' : ''}`);
  process.exit(0);
}

let blocks = toBlocks(data.segments, o.quick || o.ai || o.free);
if (ai) {
  const b = ai;
  if (o.free) log('Using the free public model: your transcript text is sent to pollinations.ai.');
  const before = wordCount(blocks.map((x) => x.text).join(' '));
  blocks = await polish(blocks, b);
  const kept = wordCount(blocks.map((x) => x.text).join(' ')) / Math.max(1, before);
  if (kept < 0.75) log(`Warning: the model returned only ${Math.round(kept * 100)}% of the words; it may have dropped content.`);
}

const md = buildMarkdown(data, blocks, { timestamps: o.timestamps });
if (o.stdout || o.output === '-') process.stdout.write(md);
else {
  const file = o.output || await freeName(slug(data.title));
  await writeFile(file, md);
  log(`Wrote ${file} (${wordCount(md)} words, captions: ${data.languageName}${data.auto && !/auto/i.test(data.languageName) ? ' (auto-generated)' : ''})`);
  process.stdout.write(file + '\n');
}
