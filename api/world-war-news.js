/**
 * World War / Global Conflict News Aggregator
 *
 * Standalone edge-function endpoint that aggregates the latest war & conflict
 * headlines from 15+ RSS sources, extracts title + summary + source, filters
 * to only recent articles (last 24h), deduplicates, and returns JSON.
 *
 * GET /api/world-war-news?limit=30
 *
 * Response:
 *   {
 *     "success": true,
 *     "count": 25,
 *     "generatedAt": "...",
 *     "articles": [{ title, summary, source, publishedAt, link }]
 *   }
 */

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

// ─── RSS Sources ────────────────────────────────────────────────────────────

const gn = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const WAR_FEEDS = [
  // Major international
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'Reuters World', url: gn('site:reuters.com world war conflict') },
  { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },

  // Defense & Military
  { name: 'Defense One', url: 'https://www.defenseone.com/rss/all/' },
  { name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/' },
  { name: 'The War Zone', url: 'https://www.twz.com/feed' },
  { name: 'USNI News', url: 'https://news.usni.org/feed' },
  { name: 'Military Times', url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Task & Purpose', url: 'https://taskandpurpose.com/feed/' },

  // Conflict regions
  { name: 'Kyiv Independent', url: gn('site:kyivindependent.com') },
  { name: 'Times of Israel', url: gn('site:timesofisrael.com war OR conflict OR military') },

  // OSINT & Think tanks
  { name: 'Bellingcat', url: gn('site:bellingcat.com') },
  { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
  { name: 'Crisis Group', url: 'https://www.crisisgroup.org/rss' },
  { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },

  // War keyword search
  { name: 'World War News', url: gn('(war OR invasion OR airstrike OR missile attack OR military operation OR troops deployed OR bombing) when:1d') },
  { name: 'Conflict Updates', url: gn('(armed conflict OR ceasefire OR frontline OR casualties OR NATO OR defense) when:1d') },
];

// ─── War/Conflict Keywords (for relevance filtering) ────────────────────────

const WAR_KEYWORDS = [
  // Direct war terms
  'war', 'invasion', 'invade', 'airstrike', 'air strike', 'drone strike',
  'missile', 'bombing', 'bombard', 'shelling', 'artillery',
  'troops', 'soldiers', 'military', 'army', 'navy', 'air force',
  'casualties', 'killed', 'wounded', 'dead',
  'frontline', 'front line', 'battlefield', 'combat',
  'offensive', 'counteroffensive', 'counter-offensive',
  'siege', 'blockade', 'occupation', 'occupied',

  // Weapons & operations
  'weapons', 'munitions', 'ammunition', 'arms',
  'nuclear', 'warhead', 'ballistic',
  'fighter jet', 'tank', 'submarine', 'warship', 'destroyer', 'aircraft carrier',
  'military operation', 'special operation',

  // Organizations & alliances
  'nato', 'pentagon', 'defense ministry', 'defence ministry',
  'armed forces', 'militia', 'rebel', 'insurgent',

  // Diplomacy around conflict
  'ceasefire', 'peace talks', 'sanctions', 'embargo',
  'escalation', 'de-escalation', 'tension',
  'threat', 'retaliation', 'deterrence',

  // Regions in conflict
  'ukraine', 'russia', 'gaza', 'israel', 'hamas', 'hezbollah',
  'taiwan', 'north korea', 'pyongyang', 'yemen', 'houthi',
  'syria', 'iran', 'iraq', 'afghanistan', 'sudan', 'ethiopia',
  'myanmar', 'libya', 'somalia', 'congo',

  // General conflict
  'conflict', 'hostilities', 'warfare', 'defense', 'defence',
  'coup', 'civil war', 'genocide', 'atrocity',
];

// ─── Constants ──────────────────────────────────────────────────────────────

const FEED_TIMEOUT_MS = 8_000;
const OVERALL_DEADLINE_MS = 25_000;
const BATCH_CONCURRENCY = 10;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_LIMIT = 50;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Simple in-memory cache (survives across requests on same isolate)
let responseCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── RSS Parsing (regex-based, no deps) ─────────────────────────────────────

function extractTag(xml, tag) {
  // CDATA first
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  // Plain tag
  const plainRe = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
  const match = xml.match(plainRe);
  if (!match) return '';

  return match[1].trim()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function extractDescription(xml) {
  // Try description, then summary, then content:encoded
  let desc = extractTag(xml, 'description');
  if (!desc) desc = extractTag(xml, 'summary');
  if (!desc) {
    const contentRe = /<content:encoded[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content:encoded>/i;
    const m = xml.match(contentRe);
    if (m) desc = m[1].trim();
  }

  if (!desc) return '';

  // Strip HTML tags to get plain text
  desc = desc.replace(/<[^>]+>/g, '').trim();
  // Collapse whitespace
  desc = desc.replace(/\s+/g, ' ');
  // Truncate to ~300 chars
  if (desc.length > 300) desc = desc.slice(0, 297) + '...';

  return desc;
}

function parseRss(xml, sourceName) {
  const items = [];
  const now = Date.now();

  // RSS <item> or Atom <entry>
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  let matches = [...xml.matchAll(itemRegex)];
  const isAtom = matches.length === 0;
  if (isAtom) matches = [...xml.matchAll(entryRegex)];

  for (const match of matches.slice(0, 10)) {
    const block = match[1];

    const title = extractTag(block, 'title');
    if (!title) continue;

    // Extract link
    let link;
    if (isAtom) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/);
      link = hrefMatch?.[1] ?? '';
    } else {
      link = extractTag(block, 'link');
    }

    // Extract pubDate
    const pubDateStr = isAtom
      ? (extractTag(block, 'published') || extractTag(block, 'updated'))
      : extractTag(block, 'pubDate');
    const parsedDate = pubDateStr ? new Date(pubDateStr) : null;
    const publishedAt = parsedDate && !isNaN(parsedDate.getTime())
      ? parsedDate.getTime()
      : null;

    // Skip items older than 24h or with no date
    if (!publishedAt || (now - publishedAt) > MAX_AGE_MS) continue;

    // Extract summary/description
    const summary = extractDescription(block);

    items.push({
      title,
      summary: summary || '',
      source: sourceName,
      publishedAt: new Date(publishedAt).toISOString(),
      link,
    });
  }

  return items;
}

// ─── War Relevance Check ────────────────────────────────────────────────────

function isWarRelated(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  return WAR_KEYWORDS.some((kw) => text.includes(kw));
}

// ─── Deduplication (by similar title) ───────────────────────────────────────

function deduplicateArticles(articles) {
  const seen = new Map();
  const result = [];

  for (const article of articles) {
    // Normalize title for comparison
    const key = article.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);

    if (!seen.has(key)) {
      seen.set(key, true);
      result.push(article);
    }
  }

  return result;
}

// ─── Fetch a single feed ────────────────────────────────────────────────────

async function fetchFeed(feed, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const resp = await fetch(feed.url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    if (!resp.ok) return [];

    const xml = await resp.text();
    return parseRss(xml, feed.name);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

// ─── Build full response ────────────────────────────────────────────────────

async function buildWarNews(limit) {
  const deadlineController = new AbortController();
  const deadlineTimeout = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS);

  try {
    let allArticles = [];

    // Fetch in batches
    for (let i = 0; i < WAR_FEEDS.length; i += BATCH_CONCURRENCY) {
      if (deadlineController.signal.aborted) break;

      const batch = WAR_FEEDS.slice(i, i + BATCH_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((feed) => fetchFeed(feed, deadlineController.signal)),
      );

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          allArticles.push(...result.value);
        }
      }
    }

    // Filter to war-related articles only
    allArticles = allArticles.filter((a) => isWarRelated(a.title, a.summary));

    // Deduplicate
    allArticles = deduplicateArticles(allArticles);

    // Sort by date (newest first)
    allArticles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    // Limit
    allArticles = allArticles.slice(0, limit);

    return {
      success: true,
      count: allArticles.length,
      generatedAt: new Date().toISOString(),
      articles: allArticles.map(({ title, summary, source, publishedAt, link }) => ({
        title,
        summary,
        source,
        publishedAt,
        link,
      })),
    };
  } finally {
    clearTimeout(deadlineTimeout);
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const url = new URL(req.url);
    const rawLimit = parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 100)
      : DEFAULT_LIMIT;

    // Check in-memory cache
    const now = Date.now();
    if (responseCache.data && (now - responseCache.ts) < CACHE_TTL_MS) {
      // Re-slice to requested limit
      const cached = { ...responseCache.data };
      cached.articles = cached.articles.slice(0, limit);
      cached.count = cached.articles.length;
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=900',
          ...corsHeaders,
        },
      });
    }

    const data = await buildWarNews(100); // fetch max, cache full set
    responseCache = { data, ts: Date.now() };

    // Slice to requested limit
    const output = { ...data };
    output.articles = output.articles.slice(0, limit);
    output.count = output.articles.length;

    return new Response(JSON.stringify(output), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=900',
        ...corsHeaders,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch war news',
      details: error.message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
