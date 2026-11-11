'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const { ANIME, MOVIES } = require('@consumet/extensions');

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '127.0.0.1';

// ─── 1. SMART ANIME SCRAPER (Direct HLS) ───
async function fetchAnime(title, episode) {
  try {
    const zoro = new ANIME.Zoro();
    const searchResults = await zoro.search(title);
    if (!searchResults || !searchResults.results || searchResults.results.length === 0) return null;

    const animeId = searchResults.results[0].id;
    const info = await zoro.fetchAnimeInfo(animeId);
    if (!info || !info.episodes) return null;
    
    const targetEp = info.episodes.find(e => e.number === parseInt(episode));
    if (!targetEp) return null;

    const sources = [];
    try {
      const subData = await zoro.fetchEpisodeSources(targetEp.id, undefined, 'sub');
      if (subData && subData.sources) {
        subData.sources.forEach(s => {
          if (s.url.includes('.m3u8')) {
            sources.push({
              label: `Zoro (SUB) - ${s.quality || 'Auto'}`,
              type: 'hls', url: s.url, quality: s.quality || '1080p',
              audio: 'sub', lang: 'ja', downloadable: true
            });
          }
        });
      }
    } catch (e) { }

    return sources.length > 0 ? sources : null;
  } catch (e) {
    return null;
  }
}

// ─── 2. SMART MOVIE SCRAPER (Direct HLS via FlixHQ) ───
async function fetchMovieNative(title, type, season, episode) {
  try {
    const flixhq = new MOVIES.FlixHQ();
    const searchResults = await flixhq.search(title);
    if (!searchResults || !searchResults.results || searchResults.results.length === 0) return null;

    // Try to find a matching movie or TV show
    const match = searchResults.results.find(r => r.type === type) || searchResults.results[0];
    const mediaInfo = await flixhq.fetchMediaInfo(match.id);
    
    let episodeId = mediaInfo.episodes?.[0]?.id; // Default for movies
    
    if (type === 'tv' && mediaInfo.episodes) {
      const targetEp = mediaInfo.episodes.find(e => e.season == season && e.episode == episode);
      if (targetEp) episodeId = targetEp.id;
    }

    if (!episodeId) return null;

    const links = await flixhq.fetchEpisodeSources(episodeId, mediaInfo.id);
    if (!links || !links.sources) return null;

    const sources = [];
    links.sources.forEach(s => {
      if (s.url.includes('.m3u8')) {
        sources.push({
          label: `FlixHQ (Native) - ${s.quality || 'Auto'}`,
          type: 'hls', url: s.url, quality: s.quality || '1080p',
          audio: 'multi', lang: 'en', downloadable: true
        });
      }
    });

    return sources.length > 0 ? sources : null;
  } catch (e) {
    return null; // Return null so it falls back to embeds
  }
}

// ─── 3. EMBED FALLBACKS (Reliable UI) ───
function fetchMovieEmbeds(type, tmdbId, season, episode) {
  const sources = [];
  const qualities = ['1080p', '720p']; 

  const providers = [
    { label: 'VidSrc', url: type === 'movie' ? `https://vidsrc.to/embed/movie/${tmdbId}` : `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}` },
    { label: '2Embed', url: type === 'movie' ? `https://2embed.cc/embed/${tmdbId}` : `https://2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}` }
  ];

  for (const p of providers) {
    for (const q of qualities) {
      sources.push({
        label: `${p.label} (${q})`,
        type: 'embed',
        url: p.url,
        quality: q,
        audio: 'multi',
        lang: 'en',
        downloadable: true 
      });
    }
  }
  return sources;
}

// ─── 4. THE ROUTER ───
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

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
      
      // 1. Try Anime Native HLS
      if (type === 'tv' && title) {
        console.log(`[Router] Trying Native Anime HLS for: ${title}`);
        const animeSources = await fetchAnime(title, episode);
        if (animeSources) sources = animeSources;
      }
      
      // 2. Try Movie Native HLS
      if (sources.length === 0 && title) {
        console.log(`[Router] Trying Native Movie HLS for: ${title}`);
        const nativeMovie = await fetchMovieNative(title, type, season, episode);
        if (nativeMovie) sources = nativeMovie;
      }

      // 3. Fallback to Embeds if scrapers fail
      if (sources.length === 0) {
        console.log(`[Router] Native scraping failed. Falling back to Embeds for TMDB: ${tmdbId}`);
        sources = fetchMovieEmbeds(type, tmdbId, season, episode);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sources }));
    } catch (err) {
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
