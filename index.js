'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const { ANIME } = require('@consumet/extensions');

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '127.0.0.1';

// ─── 1. SMART ANIME SCRAPER (Local Consumet) ───
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

// ─── 2. RELIABLE MOVIE EMBEDS (With Quality Simulation) ───
const PROVIDERS = [
  {
    label: 'VidSrc',
    movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`
  },
  {
    label: '2Embed',
    movie: (id) => `https://2embed.cc/embed/${id}`,
    tv: (id, s, e) => `https://2embed.cc/embedtv/${id}&s=${s}&e=${e}`
  },
  {
    label: 'AutoEmbed',
    movie: (id) => `https://autoembed.co/movie/tmdb/${id}`,
    tv: (id, s, e) => `https://autoembed.co/tv/tmdb/${id}-${s}-${e}`
  },
  {
    label: 'MultiEmbed',
    movie: (id) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`,
    tv: (id, s, e) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}`
  },
  {
    label: 'SmashyStream',
    movie: (id) => `https://player.smashy.stream/movie/${id}`,
    tv: (id, s, e) => `https://player.smashy.stream/tv/${id}?s=${s}&e=${e}`
  }
];

function fetchMovieEmbeds(type, tmdbId, season, episode) {
  const sources = [];
  const qualities = ['1080p', '720p', '480p']; // Simulated qualities for UI

  for (const p of PROVIDERS) {
    try {
      let url = '';
      if (type === 'movie') {
        url = p.movie(tmdbId);
      } else {
        url = p.tv(tmdbId, season, episode);
      }

      // Add the embed for each quality to give the user options
      for (const q of qualities) {
        sources.push({
          label: `${p.label} (${q})`,
          type: 'embed',
          url: url,
          quality: q,
          audio: 'multi',
          lang: 'en',
          downloadable: true // Tells Lumora to show the download button (opens embed)
        });
      }
    } catch (e) { }
  }
  return sources;
}

// ─── 3. THE ROUTER ───
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
      
      // Try Anime first for TV shows
      if (type === 'tv' && title) {
        console.log(`[Router] Checking Anime for: ${title}`);
        const animeSources = await fetchAnime(title, episode);
        if (animeSources && animeSources.length > 0) {
          sources = animeSources;
        }
      }
      
      // Fallback to Reliable Embeds if no anime found or if it's a movie
      if (sources.length === 0) {
        console.log(`[Router] Providing reliable embeds for TMDB: ${tmdbId}`);
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
