'use strict';

/**
 * chat-emotes.js
 * ────────────────────────────────────────────────────────────────────────────
 * Shared emote-segment builder used by BOTH the OBS overlay (zchat-overlay)
 * and the dashboard chat column.
 *
 * Previously this logic lived only inside src/plugins/zchat-overlay/index.js
 * and was only ever run against messages flowing into that plugin's own
 * queue.onMessage subscription. The dashboard chat column got a *different*
 * message object (the raw finalMsg from the pipeline, via
 * dashboard.pushChatMessage) that never had `.segments` computed on it, so
 * it fell back to plain text — emotes never rendered on the dashboard.
 *
 * Centralising the builder here means both consumers produce byte-identical
 * segment arrays for a given message.
 */

/**
 * Parse Twitch `emotes` tag into a sorted list of {start,end,url}.
 * emotes tag format:  "302856228:0-6,8-14/emotesv2_abc:16-22"
 * @param {string|undefined} emotesTag
 * @returns {{ start:number, end:number, url:string }[]}
 */
function parseTwitchEmotesTag(emotesTag) {
  if (!emotesTag || typeof emotesTag !== 'string') return [];

  const result = [];
  for (const part of emotesTag.split('/')) {
    const [id, positions] = part.split(':');
    if (!id || !positions) continue;
    const url = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
    for (const range of positions.split(',')) {
      const [s, e] = range.split('-').map(Number);
      if (!isNaN(s) && !isNaN(e)) result.push({ start: s, end: e, url });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

/**
 * Build a Segment[] from raw message text + Twitch emote ranges + YouTube emoji objects
 * + optional third-party emote word→url map (BTTV/FFZ/7TV).
 *
 * @param {string} message
 * @param {string|undefined} emotesTag        Twitch `emotes` tag
 * @param {Array|undefined} ytEmotes          YouTube emoji objects
 * @param {Record<string,string>|undefined} thirdPartyEmotes  word → emote URL map
 */
function buildSegments(message, emotesTag, ytEmotes, thirdPartyEmotes) {
  const replacements = [];

  for (const { start, end, url } of parseTwitchEmotesTag(emotesTag)) {
    replacements.push({ start, end: end + 1, url, alt: message.slice(start, end + 1) });
  }

  if (Array.isArray(ytEmotes)) {
    for (const e of ytEmotes) {
      if (e.url && typeof e.startIndex === 'number' && typeof e.endIndex === 'number') {
        replacements.push({ start: e.startIndex, end: e.endIndex, url: e.url, alt: e.altText || '' });
      }
    }
  }

  replacements.sort((a, b) => a.start - b.start);
  const deduped = [];
  let cursor = 0;
  for (const r of replacements) {
    if (r.start >= cursor) { deduped.push(r); cursor = r.end; }
  }

  const segments = [];
  let pos = 0;
  for (const { start, end, url, alt } of deduped) {
    if (start > pos) segments.push({ type: 'text', text: message.slice(pos, start) });
    segments.push({ type: 'emote', url, alt });
    pos = end;
  }
  if (pos < message.length) segments.push({ type: 'text', text: message.slice(pos) });

  // Seed with full message text if no platform emotes produced any segments —
  // without this, the third-party loop below runs against an empty array and
  // returns nothing, causing emote names to render as plain text.
  if (!segments.length) segments.push({ type: 'text', text: message });

  if (thirdPartyEmotes && Object.keys(thirdPartyEmotes).length) {
    const out = [];
    for (const seg of segments) {
      if (seg.type !== 'text') { out.push(seg); continue; }
      const words = seg.text.split(/(\s+)/);
      let buf = '';
      for (const token of words) {
        if (/\s/.test(token)) { buf += token; continue; }
        const url = thirdPartyEmotes[token];
        if (url) {
          // Flush buffered text (including preceding whitespace) before the emote
          if (buf) { out.push({ type: 'text', text: buf }); buf = ''; }
          out.push({ type: 'emote', url, alt: token });
        } else {
          buf += token;
        }
      }
      if (buf) out.push({ type: 'text', text: buf });
    }
    return out;
  }

  return segments;
}

module.exports = { parseTwitchEmotesTag, buildSegments };
