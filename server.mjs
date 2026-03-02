/**
 * Standalone Node.js server for Railway deployment.
 * Handles /api/world-war-news endpoint.
 */

import { createServer } from 'http';
import sharp from 'sharp';

const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FEED_TIMEOUT = 8_000;
const OVERALL_DEADLINE = 25_000;
const MAX_AGE = 24 * 60 * 60 * 1000;
const BATCH = 10;

const gn = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const WAR_FEEDS = [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'Reuters World', url: gn('site:reuters.com world war conflict') },
    { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
    { name: 'Defense One', url: 'https://www.defenseone.com/rss/all/' },
    { name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/' },
    { name: 'The War Zone', url: 'https://www.twz.com/feed' },
    { name: 'USNI News', url: 'https://news.usni.org/feed' },
    { name: 'Military Times', url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml' },
    { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml' },
    { name: 'Task & Purpose', url: 'https://taskandpurpose.com/feed/' },
    { name: 'Kyiv Independent', url: gn('site:kyivindependent.com') },
    { name: 'Times of Israel', url: gn('site:timesofisrael.com war OR conflict OR military') },
    { name: 'Bellingcat', url: gn('site:bellingcat.com') },
    { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
    { name: 'Crisis Group', url: 'https://www.crisisgroup.org/rss' },
    { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },
    { name: 'World War News', url: gn('(war OR invasion OR airstrike OR missile attack OR military operation OR troops deployed OR bombing) when:1d') },
    { name: 'Conflict Updates', url: gn('(armed conflict OR ceasefire OR frontline OR casualties OR NATO OR defense) when:1d') },
];

const WAR_KW = [
    'war', 'invasion', 'airstrike', 'air strike', 'drone strike', 'missile', 'bombing', 'shelling', 'artillery',
    'troops', 'soldiers', 'military', 'army', 'navy', 'casualties', 'killed', 'wounded', 'dead',
    'frontline', 'battlefield', 'combat', 'offensive', 'counteroffensive', 'siege', 'blockade', 'occupation',
    'nuclear', 'warhead', 'ballistic', 'fighter jet', 'tank', 'submarine', 'warship', 'aircraft carrier',
    'nato', 'pentagon', 'defense ministry', 'armed forces', 'militia', 'rebel', 'insurgent',
    'ceasefire', 'sanctions', 'embargo', 'escalation', 'retaliation', 'deterrence',
    'ukraine', 'russia', 'gaza', 'israel', 'hamas', 'hezbollah', 'taiwan', 'north korea', 'yemen', 'houthi',
    'syria', 'iran', 'iraq', 'afghanistan', 'sudan', 'myanmar', 'libya', 'somalia', 'congo',
    'conflict', 'hostilities', 'warfare', 'defense', 'defence', 'coup', 'civil war', 'genocide',
];

let cache = { data: null, ts: 0 };

function extractTag(xml, tag) {
    const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
    const m1 = xml.match(cdataRe);
    if (m1) return m1[1].trim();
    const plainRe = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
    const m2 = xml.match(plainRe);
    return m2 ? m2[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : '';
}

function extractDesc(xml) {
    let d = extractTag(xml, 'description') || extractTag(xml, 'summary');
    if (!d) { const m = xml.match(/<content:encoded[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content:encoded>/i); if (m) d = m[1].trim(); }
    if (!d) return '';
    d = d.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return d.length > 300 ? d.slice(0, 297) + '...' : d;
}

function extractImage(xml) {
    // 1. <media:content url="...">
    let m = xml.match(/<media:content[^>]+url=["']([^"']+)["']/i);
    if (m) return m[1];
    // 2. <media:thumbnail url="...">
    m = xml.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
    if (m) return m[1];
    // 3. <enclosure url="..." type="image/...">
    m = xml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image\/[^"']+["']/i);
    if (m) return m[1];
    m = xml.match(/<enclosure[^>]+type=["']image\/[^"']+["'][^>]+url=["']([^"']+)["']/i);
    if (m) return m[1];
    // 4. <img src="..."> in description/content
    m = xml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) return m[1];
    return null;
}

async function fetchFeed(feed, signal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        const resp = await fetch(feed.url, {
            headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
            signal: controller.signal,
        });
        if (!resp.ok) return [];
        const xml = await resp.text();
        const items = [];
        const now = Date.now();
        const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
        const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
        let matches = [...xml.matchAll(itemRe)];
        const isAtom = matches.length === 0;
        if (isAtom) matches = [...xml.matchAll(entryRe)];
        for (const m of matches.slice(0, 10)) {
            const b = m[1];
            const title = extractTag(b, 'title');
            if (!title) continue;
            let link = '';
            if (isAtom) { const h = b.match(/<link[^>]+href=["']([^"']+)["']/); link = h?.[1] ?? ''; }
            else link = extractTag(b, 'link');
            const pubStr = isAtom ? (extractTag(b, 'published') || extractTag(b, 'updated')) : extractTag(b, 'pubDate');
            const pd = pubStr ? new Date(pubStr) : null;
            const ts = pd && !isNaN(pd.getTime()) ? pd.getTime() : null;
            if (!ts || (now - ts) > MAX_AGE) continue;
            const image = extractImage(b);
            items.push({ title, summary: extractDesc(b), source: feed.name, publishedAt: new Date(ts).toISOString(), link, image });
        }
        return items;
    } catch { return []; }
    finally { clearTimeout(timeout); signal.removeEventListener('abort', onAbort); }
}

async function buildWarNews(limit) {
    const dc = new AbortController();
    const dt = setTimeout(() => dc.abort(), OVERALL_DEADLINE);
    try {
        let all = [];
        for (let i = 0; i < WAR_FEEDS.length; i += BATCH) {
            if (dc.signal.aborted) break;
            const batch = WAR_FEEDS.slice(i, i + BATCH);
            const settled = await Promise.allSettled(batch.map(f => fetchFeed(f, dc.signal)));
            for (const r of settled) { if (r.status === 'fulfilled') all.push(...r.value); }
        }
        all = all.filter(a => { const t = `${a.title} ${a.summary}`.toLowerCase(); return WAR_KW.some(kw => t.includes(kw)); });
        const seen = new Map();
        all = all.filter(a => { const k = a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60); if (seen.has(k)) return false; seen.set(k, true); return true; });
        all.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
        return { success: true, count: all.length, generatedAt: new Date().toISOString(), articles: all.slice(0, limit) };
    } finally { clearTimeout(dt); }
}

const server = createServer(async (req, res) => {
    const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ status: 'ok', endpoint: '/api/world-war-news' }));
        return;
    }

    // World War News endpoint
    if (url.pathname === '/api/world-war-news') {
        const rawLimit = parseInt(url.searchParams.get('limit') || '', 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;

        // Cache check (10 min)
        if (cache.data && (Date.now() - cache.ts) < 600_000) {
            const out = { ...cache.data, articles: cache.data.articles.slice(0, limit), count: Math.min(cache.data.articles.length, limit) };
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders });
            res.end(JSON.stringify(out));
            return;
        }

        try {
            const data = await buildWarNews(100);
            cache = { data, ts: Date.now() };
            const out = { ...data, articles: data.articles.slice(0, limit), count: Math.min(data.articles.length, limit) };
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders });
            res.end(JSON.stringify(out));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
    }

    // Image overlay endpoint (GET with url param OR POST with base64 body)
    if (url.pathname === '/api/overlay-image') {
        try {
            let imgBuffer;
            let title;

            if (req.method === 'POST') {
                // POST: accept JSON body with base64 image and title
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks).toString());
                if (!body.image || !body.title) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                    res.end(JSON.stringify({ error: 'POST body needs image (base64) and title' }));
                    return;
                }
                imgBuffer = Buffer.from(body.image, 'base64');
                title = body.title;
            } else {
                // GET: accept url and title as query params
                const imageUrl = url.searchParams.get('url');
                title = url.searchParams.get('title');
                if (!imageUrl || !title) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                    res.end(JSON.stringify({ error: 'Missing url or title query parameter' }));
                    return;
                }
                const imgResp = await fetch(imageUrl, { headers: { 'User-Agent': UA } });
                if (!imgResp.ok) throw new Error(`Image fetch failed: ${imgResp.status}`);
                imgBuffer = Buffer.from(await imgResp.arrayBuffer());
            }

            // Resize to 1:1 square (Instagram/Facebook optimal)
            const W = 1080;
            const H = 1080;
            const base = await sharp(imgBuffer)
                .resize(W, H, { fit: 'cover', position: 'center' })
                .toBuffer();

            // Create gradient overlay (strong bottom fade from 30%)
            const gradientSvg = `<svg width="${W}" height="${H}">
                <defs>
                    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="black" stop-opacity="0"/>
                        <stop offset="30%" stop-color="black" stop-opacity="0"/>
                        <stop offset="60%" stop-color="black" stop-opacity="0.5"/>
                        <stop offset="80%" stop-color="black" stop-opacity="0.75"/>
                        <stop offset="100%" stop-color="black" stop-opacity="0.9"/>
                    </linearGradient>
                </defs>
                <rect width="${W}" height="${H}" fill="url(#fade)"/>
            </svg>`;

            // Word wrap title for center alignment
            const maxCharsPerLine = 28;
            const words = title.split(' ');
            const lines = [];
            let currentLine = '';
            for (const word of words) {
                if ((currentLine + ' ' + word).trim().length > maxCharsPerLine && currentLine) {
                    lines.push(currentLine.trim());
                    currentLine = word;
                } else {
                    currentLine = currentLine ? currentLine + ' ' + word : word;
                }
            }
            if (currentLine.trim()) lines.push(currentLine.trim());
            const maxLines = 5;
            if (lines.length > maxLines) {
                lines.splice(maxLines);
                lines[maxLines - 1] = lines[maxLines - 1].slice(0, -3) + '...';
            }

            // Build text SVG — large bold font, center aligned
            const fontSize = 56;
            const lineHeight = 72;
            const textBlockHeight = lines.length * lineHeight;
            const startY = H - textBlockHeight - 50;
            const centerX = W / 2;

            const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const textLines = lines.map((line, i) =>
                `<text x="${centerX}" y="${startY + (i * lineHeight)}" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, Noto Sans, FreeSans, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.5" fill="white" filter="url(#shadow)">${esc(line)}</text>`
            ).join('\n');

            const textSvg = `<svg width="${W}" height="${H}">
                <defs>
                    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
                        <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="black" flood-opacity="0.9"/>
                    </filter>
                </defs>
                ${textLines}
            </svg>`;

            // Composite: base image + gradient + text
            const result = await sharp(base)
                .composite([
                    { input: Buffer.from(gradientSvg), top: 0, left: 0 },
                    { input: Buffer.from(textSvg), top: 0, left: 0 },
                ])
                .jpeg({ quality: 95 })
                .toBuffer();

            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': result.length,
                'Cache-Control': 'public, max-age=3600',
                ...corsHeaders,
            });
            res.end(result);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'Not found. Use /api/world-war-news' }));
});

server.listen(PORT, () => {
    console.log(`War News API running on port ${PORT}`);
    console.log(`Endpoint: http://localhost:${PORT}/api/world-war-news`);
});
