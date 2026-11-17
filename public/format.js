// Shared by the web page (browser) and cli.js (Node). Pure functions, no DOM or Node APIs.

// Rule-based cleanup: removes ums/ahs, [Music] tags and stutters, fixes spacing and capitalization.
export function quickClean(t) {
  return t
    .replace(/\[(?:music|applause|laughter|inaudible|♪|\s)*\]|\((?:music|applause|laughter)\)|♪+/gi, ' ')
    .replace(/\b(?:u+m+|u+h+|e+r+m*|a+h+m*|h+m+|m+hm+|uh-huh)\b[,.…]*/gi, ' ')
    .replace(/\b(\w+(?:'\w+)?)(?:[,\s]+\1\b){1,}/gi, '$1')            // "I I I think" -> "I think"
    .replace(/\b(\w+ \w+)(?:[,\s]+\1\b)+/gi, '$1')                    // "going to going to" -> "going to"
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])\1+/g, '$1')
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\s{2,}/g, ' ').trim();
}

export const fmt = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

// Groups caption segments [{start, text}] into paragraphs [{start, text}].
export function paragraphs(segs) {
  const out = []; let cur = null, last = 0;
  for (const s of segs) {
    const gap = s.start - last;
    if (!cur || cur.text.length > 600 && /[.!?]$/.test(cur.text) || gap > 4 && cur.text.length > 200) { cur = { start: s.start, text: '' }; out.push(cur); }
    cur.text += (cur.text ? ' ' : '') + s.text; last = s.start;
  }
  return out;
}

// Groups paragraph blocks into LLM-sized chunks.
export function chunk(blocks, max = 1800) {
  const chunks = []; let c = [], len = 0;
  for (const b of blocks) { if (len + b.text.length > max && c.length) { chunks.push(c); c = []; len = 0; } c.push(b); len += b.text.length; }
  if (c.length) chunks.push(c);
  return chunks;
}

// True when the text ends a sentence ("...", "…" and trailing commas do not count).
export function endsSentence(t) {
  t = t.trim().replace(/["'”’)\]]+$/, '');
  return /[.!?]$/.test(t) && !/\.\.\.$/.test(t);
}

export const wordCount = (t) => (t.match(/\S+/g) || []).length;

// Blocks from a transcript: raw captions, or quick-cleaned when `quick` is true.
export function toBlocks(segments, quick) {
  return paragraphs(segments).map((p) => ({ start: p.start, text: quick ? quickClean(p.text) : p.text }));
}

// Builds the final markdown document.
export function buildMarkdown(data, blocks, { timestamps = false } = {}) {
  const lines = [`# ${data.title}`, ''];
  lines.push(`**Channel:** ${data.author || 'unknown'} · **Source:** https://youtu.be/${data.videoId} · **Captions:** ${data.languageName}${data.auto && !/auto/i.test(data.languageName) ? ' (auto-generated)' : ''}`, '');
  for (const b of blocks) lines.push((timestamps ? `**[${fmt(b.start)}]** ` : '') + b.text, '');
  return lines.join('\n').trim() + '\n';
}
