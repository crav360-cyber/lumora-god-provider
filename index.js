'use strict';
const http = require('node:http');
const { URL } = require('node:url');

// Puppeteer & Serverless Chromium setup
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

// Apply stealth plugin to bypass Cloudflare/VidSrc blocks
puppeteer.use(StealthPlugin());

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '127.0.0.1';

// ─── 1. SMART ANIME SCRAPER (Uses API for Sub/Dub & Qualities) ───
async function fetchAnime(title, episode) {
  try {
    const query = `query ($search: String) { Media (search: $search, type: ANIME) { id } }`;
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { search: title } })
    });
    const json = await res.json();
    const anilistId = json.data?.Media?.id;
    if (!anilistId) return null;

    const infoRes = await fetch(`https://aniwatch-api-tau.vercel.app/anime/zoro/info?id=${anilistId}`);
    const info = await infoRes.json();
    if (!info || !info.episodes) return null;

    const targetEp = info.episodes.find(e => e.number === parseInt(episode));
    if (!targetEp) return null;

    const sources = [];
    
    // Fetch Sub
    try {
      const subRes = await fetch(`https://aniwatch-api-tau.vercel.app/anime/zoro/watch?episodeId=${targetEp.id}&dub=false`);
      const subData = await subRes.json();
      if (subData.sources) {
        subData.sources.forEach(s => {
          sources.push({
            label: `Zoro (SUB) - ${s.quality || 'Auto'}`,
            type: 'hls', url: s.url, quality: s.quality || '1080p',
            audio: 'sub', lang: 'ja', downloadable: true
          });
        });
      }
    } catch (e) { /* Ignore sub fetch errors */ }

    // Fetch Dub
    try {
      const dubRes = await fetch(`https://aniwatch-api-tau.vercel.app/anime/zoro/watch?episodeId=${targetEp.id}&dub=true`);
      const dubData = await dubRes.json();
      if (dubData.sources && dubData.sources.length > 0) {
        dubData.sources.forEach(s => {
          sources.push({
            label: `Zoro (DUB) - ${s.quality || 'Auto'}`,
            type: 'hls', url: s.url, quality: s.quality || '1080p',
            audio: 'dub', lang: 'en', downloadable: true
          });
        });
      }
    } catch (e) { /* Ignore dub fetch errors */ }

    return sources.length > 0 ? sources : null;
  } catch (e) {
    console.error('Anime fetch failed:', e.message);
    return null;
  }
}

// ─── 2. SMART MOVIE SCRAPER (Puppeteer + M3U8 Quality Parsing) ───
async function fetchMovie(type, tmdbId, season, episode) {
  let browser;
  try {
    // Launch serverless chromium
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    
    const page = await browser.newPage();
    
    // Block images/CSS to save memory and speed up loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const targetUrl = type === 'movie' 
      ? `https://vidsrc.to/embed/movie/${tmdbId}`
      : `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}`;

    let masterM3u8 = null;
    
    // Intercept the network to find the master M3U8 playlist
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('.m3u8') && !url.includes('ad') && !masterM3u8) {
        masterM3u8 = url;
      }
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    
    // Try clicking play if it doesn't auto-play
    try {
      await page.evaluate(() => {
        const btn = document.querySelector('.play-button, #play, video');
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 4000));
    } catch (e) {}

    if (!masterM3u8) return [];

    // ─── SMART QUALITY PARSING ───
    // Download the M3U8 file to see exactly what qualities are inside
    const m3u8Res = await fetch(masterM3u8);
    const m3u8Text = await m3u8Res.text();
    
    const sources = [];
    const lines = m3u8Text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('#EXT-X-STREAM-INF')) {
        // Extract resolution (e.g., 1920x1080)
        const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
        let quality = 'Auto';
        if (resMatch) {
          const height = parseInt(resMatch[2]);
          if (height >= 1080) quality = '1080p';
          else if (height >= 720) quality = '720p';
          else if (height >= 480) quality = '480p';
          else quality = `${height}p`;
        }
        
        // The next line is the actual URL for this quality
        const streamUrl = lines[i + 1]?.trim();
        if (streamUrl && streamUrl.startsWith('http')) {
          sources.push({
            label: `VidSrc (Direct)`,
            type: 'hls',
            url: streamUrl,
            quality: quality,
            audio: 'multi',
            lang: 'en',
            downloadable: true
          });
        }
      }
    }

    // If no master playlist (it's already a direct stream), just return the link
    if (sources.length === 0 && masterM3u8) {
      sources.push({ 
        label: 'VidSrc (Direct)', type: 'hls', url: masterM3u8, 
        quality: '1080p', audio: 'multi', lang: 'en', downloadable: true 
      });
    }

    return sources;
  } catch (error) {
    console.error('Puppeteer Movie Error:', error.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ─── 3. THE ROUTER ───
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  
  // Health check endpoint
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // Lumora resolve endpoint
  if (url.pathname === '/lumora/v1/resolve') {
    const type = url.searchParams.get('type');
    const tmdbId = url.searchParams.get('tmdb');
    const title = url.searchParams.get('title');
    const season = url.searchParams.get('season') || 1;
    const episode = url.searchParams.get('episode') || 1;

    if (!tmdbId) { 
      res.writeHead(400); 
      return res.end(JSON.stringify({ error: 'Missing TMDB ID' })); 
    }

    try {
      let sources = [];
      
      // Smart Routing: If it's a TV show, check if it's an Anime first.
      if (type === 'tv' && title) {
        console.log(`Checking Anime sources for: ${title}`);
        const animeSources = await fetchAnime(title, episode);
        
        if (animeSources && animeSources.length > 0) {
          console.log(`Found Anime! Returning ${animeSources.length} streams.`);
          sources = animeSources;
        }
      }
      
      // If no anime sources found, fallback to Puppeteer Movie/TV scraper
      if (sources.length === 0) {
        console.log(`Scraping Movie/TV sources via Puppeteer for TMDB: ${tmdbId}`);
        sources = await fetchMovie(type, tmdbId, season, episode);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sources }));
    } catch (err) {
      console.error('Router Error:', err.message);
      res.writeHead(500);
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Unified God Provider listening on ${HOST}:${PORT}`);
});
