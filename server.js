// YT Transcribe — local server. No dependencies (Node 18+).
// Run: node server.js   then open http://localhost:3000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OMLX = process.env.OMLX_HOST || 'http://127.0.0.1:8888';
const stripThink = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const CLIENTS = [
  { // Android client currently returns caption URLs that need no PO token
    context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } },
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
  },
  {
    context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en' } },
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  },
];

export function parseVideoId(input) {
  input = String(input || '').trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input.includes('://') ? input : 'https://' + input);
    const h = u.hostname.replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (h.endsWith('youtube.com') || h.endsWith('youtube-nocookie.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

async function getPlayer(videoId) {
  let last;
  for (const c of CLIENTS) {
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua },
        body: JSON.stringify({ context: c.context, videoId }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      const tracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks?.length) return { player: j, ua: c.ua };
      last = j;
    } catch (e) { last = { err: e.message }; }
  }
  return { player: last, ua: CLIENTS[0].ua };
}

const tname = (t) => t.name?.simpleText || t.name?.runs?.map((r) => r.text).join('') || t.languageCode;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(\w+);/g, (m, n) => ENT[n] ?? m);

// Parses YouTube timedtext XML (formats 1 and 3) into [{start, text}] (seconds)
export function parseTimedText(xml) {
  const out = [];
  const re = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[2];
    const t = attrs.match(/\bt="(\d+)"/);
    const start = t ? +t[1] / 1000 : parseFloat((attrs.match(/\bstart="([\d.]+)"/) || [])[1] ?? 0);
    const text = decode(decode(m[3].replace(/<[^>]+>/g, ''))).replace(/\s+/g, ' ').trim();
    if (text) out.push({ start, text });
  }
  return out;
}

async function getTranscript(input, lang) {
  const id = parseVideoId(input);
  if (!id) throw Object.assign(new Error('That does not look like a YouTube URL or video ID.'), { status: 400 });
  const { player, ua } = await getPlayer(id);
  const status = player?.playabilityStatus;
  if (status && status.status !== 'OK' && !player.captions) {
    throw Object.assign(new Error(`YouTube says: ${status.reason || status.status}`), { status: 422 });
  }
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) {
    throw Object.assign(new Error('This video has no caption track (manual or auto-generated).'), { status: 404 });
  }
  const pick =
    tracks.find((t) => lang && t.languageCode === lang) ||
    tracks.find((t) => t.languageCode.startsWith('en') && t.kind !== 'asr') ||
    tracks.find((t) => t.kind !== 'asr') ||
    tracks.find((t) => t.languageCode.startsWith('en')) ||
    tracks[0];
  const url = pick.baseUrl.replace(/&fmt=\w+/, '');
  const r = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(15000) });
  const xml = await r.text();
  const segments = parseTimedText(xml);
  if (!segments.length) {
    throw Object.assign(new Error('YouTube returned an empty caption file (it may be blocking this request). Try again later.'), { status: 502 });
  }
  const d = player.videoDetails || {};
  return {
    videoId: id,
    title: d.title || id,
    author: d.author || '',
    lengthSeconds: +d.lengthSeconds || null,
    language: pick.languageCode,
    languageName: tname(pick),
    auto: pick.kind === 'asr',
    tracks: tracks.map((t) => ({ code: t.languageCode, name: tname(t), auto: t.kind === 'asr' })),
    segments,
  };
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((ok, no) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
  req.on('end', () => ok(b));
  req.on('error', no);
});

const SYSTEM = `You clean up speech transcripts. The input is raw text from a spoken video, often without punctuation.
Rewrite it as clean, readable prose:
- Remove filler words and sounds (um, uh, ah, er, like, you know) and false starts.
- Where the speaker stumbles, repeats, or corrects themselves, keep only the corrected, intended wording.
- Fix obvious mis-heard words, punctuation, capitalization and sentence boundaries.
- Do NOT summarize, add information, or change the meaning. Keep the speaker's voice and all substantive content.
- Output ONLY the cleaned text, with blank lines between paragraphs. No preamble.`;

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/transcript') {
      const data = await getTranscript(url.searchParams.get('url'), url.searchParams.get('lang'));
      return json(res, 200, data);
    }
    if (url.pathname === '/api/models') {
      const key = req.headers['x-omlx-key'] || process.env.OMLX_API_KEY || '';
      const out = { ollama: { available: false, models: [] }, omlx: { available: false, needsKey: false, models: [] } };
      try {
        const j = await (await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(2500) })).json();
        out.ollama = { available: true, models: (j.models || []).map((m) => m.name) };
      } catch {}
      try {
        const r = await fetch(OMLX + '/v1/models', { headers: key ? { Authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(2500) });
        out.omlx.available = true; out.omlx.status = r.status;
        if (r.status === 401 || r.status === 403) out.omlx.needsKey = true;
        else out.omlx.models = ((await r.json()).data || []).map((m) => m.id);
      } catch {}
      return json(res, 200, out);
    }
    if (url.pathname === '/api/clean' && req.method === 'POST') {
      const { model, text } = JSON.parse(await readBody(req));
      const [backend, ...rest] = String(model).split(':');
      const name = rest.join(':');
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }];
      if (backend === 'omlx') {
        const key = req.headers['x-omlx-key'] || process.env.OMLX_API_KEY || '';
        const up = await fetch(OMLX + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
          body: JSON.stringify({ model: name, messages, temperature: 0.1, stream: false }),
        });
        const j = await up.json();
        if (!up.ok) return json(res, 502, { error: j.error?.message || 'oMLX error' });
        return json(res, 200, { text: stripThink(j.choices?.[0]?.message?.content) });
      }
      const up = await fetch(OLLAMA + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: false, think: false, options: { temperature: 0.1, num_ctx: 8192 }, messages }),
      });
      const j = await up.json();
      if (!up.ok) return json(res, 502, { error: j.error || 'Ollama error' });
      return json(res, 200, { text: stripThink(j.message?.content) });
    }
    // static
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const p = path.join(ROOT, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!p.startsWith(path.join(ROOT, 'public'))) return json(res, 403, { error: 'forbidden' });
    const body = await readFile(p);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': (types[path.extname(p)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    json(res, e.status || 500, { error: e.message });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  http.createServer(handle).listen(PORT, '127.0.0.1', () => {
    console.log(`YT Transcribe running at http://localhost:${PORT}`);
  });
}
