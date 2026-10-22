const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

let mainWindow;
let frontendServer;
const frontendSockets = new Set();
const auxiliaryWindows = new Set();
let youtubeFeedCache = null;
let youtubeFeedCacheExpiresAt = 0;
const youtubeProvinceCache = new Map();
const provincialNewsCache = new Map();
let shutdownPromise;
let shutdownComplete = false;
const FIREBASE_AUTH_HANDLER_ORIGIN = 'https://noaiverdad-72aba.firebaseapp.com';

const YOUTUBE_CHANNELS = [
  ['Ecuavisa', 'UCRUV3nUNSc-xpBrTwQOCQQg'],
  ['Teleamazonas', 'UCCwRtme3lumNRQXMO2EvCvw'],
  ['Primicias', 'UCe6Gi8_PZp9gcEZb5hTCPdQ'],
  ['TC Televisión', 'UCMDsWeFwRQ5BRzNLFzpc-ew'],
  ['Ecuador TV', 'UCfXVS_zw_XmAx8iIiia1IkA']
];

const PROVINCE_LOCALITIES = {
  'Azuay': ['Cuenca', 'Gualaceo', 'Azuay'], 'Bolívar': ['Guaranda', 'San Miguel de Bolívar', 'Bolívar Ecuador'],
  'Cañar': ['Azogues', 'La Troncal', 'Cañar'], 'Carchi': ['Tulcán', 'Montúfar', 'Carchi'],
  'Chimborazo': ['Riobamba', 'Alausí', 'Chimborazo'], 'Cotopaxi': ['Latacunga', 'La Maná', 'Cotopaxi'],
  'El Oro': ['Machala', 'Santa Rosa', 'El Oro Ecuador'], 'Esmeraldas': ['Esmeraldas', 'Quinindé', 'Atacames'],
  'Galápagos': ['Puerto Ayora', 'San Cristóbal Galápagos', 'Galápagos'], 'Guayas': ['Guayaquil', 'Durán', 'Guayas'],
  'Imbabura': ['Ibarra', 'Otavalo', 'Imbabura'], 'Loja': ['Loja', 'Catamayo', 'Macará'],
  'Los Ríos': ['Babahoyo', 'Quevedo', 'Los Ríos Ecuador'], 'Manabí': ['Portoviejo', 'Manta', 'Manabí'],
  'Morona Santiago': ['Macas', 'Gualaquiza', 'Morona Santiago'], 'Napo': ['Tena', 'Archidona', 'Napo Ecuador'],
  'Orellana': ['El Coca', 'Francisco de Orellana', 'Orellana Ecuador'], 'Pastaza': ['Puyo', 'Mera', 'Pastaza Ecuador'],
  'Pichincha': ['Quito', 'Cayambe', 'Pichincha'], 'Santa Elena': ['Salinas', 'La Libertad', 'Santa Elena Ecuador'],
  'Santo Domingo de los Tsáchilas': ['Santo Domingo', 'La Concordia', 'Santo Domingo de los Tsáchilas'],
  'Sucumbíos': ['Lago Agrio', 'Nueva Loja', 'Sucumbíos'], 'Tungurahua': ['Ambato', 'Baños', 'Tungurahua'],
  'Zamora Chinchipe': ['Zamora', 'Yantzaza', 'Zamora Chinchipe']
};

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function xmlValue(xml, tag) {
  const escapedTag = tag.replace(':', '\\:');
  const match = xml.match(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapedTag}>`, 'i'));
  return match ? decodeXml(match[1].trim()) : '';
}

async function getYoutubeElectionVideos() {
  if (youtubeFeedCache?.length && Date.now() < youtubeFeedCacheExpiresAt) return youtubeFeedCache;

  const results = [];
  let successfulChannels = 0;
  await Promise.all(YOUTUBE_CHANNELS.map(async ([channel, channelId]) => {
    try {
      const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; NoAIVerdad/1.0)' };
      const rssResponse = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
        headers, signal: AbortSignal.timeout(12000)
      });
      if (!rssResponse.ok) throw new Error(`YouTube feed returned ${rssResponse.status}`);
      successfulChannels++;
      const xml = await rssResponse.text();
      for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
        const title = xmlValue(entry, 'title');
        const videoId = xmlValue(entry, 'yt:videoId');
        const fecha = xmlValue(entry, 'published');
        if (!title || !videoId) continue;
        results.push({
          titulo: title,
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
          fecha,
          fuente: channel,
          canal: channel,
          anio: (fecha.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || ''
        });
      }
    } catch (error) {
      console.warn(`[YouTube RSS] Fuente temporalmente no disponible: ${channel} (${error.message})`);
    }
  }));

  if (!successfulChannels || !results.length) {
    // Empty results are never cached; retry the provider on the next request.
    youtubeFeedCache = null;
    youtubeFeedCacheExpiresAt = 0;
    throw new Error(successfulChannels ? 'YouTube RSS feeds contained no videos' : 'YouTube RSS is currently unavailable');
  }
  results.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
  youtubeFeedCache = results;
  youtubeFeedCacheExpiresAt = Date.now() + 10 * 60 * 1000;
  console.log(`[YouTube RSS] ${results.length} videos cargados de ${successfulChannels} canales nacionales.`);
  return results;
}

async function getProvincialYoutubeVideos(province) {
  const cacheKey = String(province || '').trim();
  const cached = youtubeProvinceCache.get(cacheKey);
  if (cached?.videos?.length && cached.expiresAt > Date.now()) return cached.videos;

  const localities = PROVINCE_LOCALITIES[cacheKey] || [cacheKey];
  const nationalPromise = getYoutubeElectionVideos().catch(() => []);
  const topics = [
    'elecciones seccionales Ecuador 2027',
    'CNE calendario electoral elecciones Ecuador',
    'candidatos prefectura alcaldía elecciones',
    'prefecto alcalde concejales campaña electoral',
    'asambleístas provinciales elecciones Ecuador',
    'debate propuestas campaña elecciones Ecuador',
    'resultados elecciones CNE Ecuador'
  ];
  const queries = [...new Set(localities.flatMap(locality => topics.map(topic => `${topic} ${locality} Ecuador`)))];
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  const localTerms = localities.map(normalize);
  const electionTerms = ['eleccion', 'electoral', 'cne', 'candidat', 'prefect', 'alcald', 'concej', 'asamble', 'vot', 'sufrag', 'campan', 'consulta popular', 'papeleta', 'debate'].map(normalize);
  const isElectionRelevant = title => electionTerms.some(term => normalize(title).includes(term));
  const results = [];
  const seen = new Set();
  let nextQuery = 0;
  const worker = async () => {
    while (nextQuery < queries.length) {
      const query = queries[nextQuery++];
      const [youtubeResult, googleResult] = await Promise.allSettled([
        buscarYoutube(query), buscarGoogleNewsYoutube(query)
      ]);
      const candidates = [];
      if (youtubeResult.status === 'fulfilled') candidates.push(...youtubeResult.value);
      if (googleResult.status === 'fulfilled') candidates.push(...googleResult.value);
      for (const video of candidates) {
        if (!video.titulo || !isElectionRelevant(video.titulo) || seen.has(video.url)) continue;
        seen.add(video.url);
        results.push({ ...video, provincia: cacheKey, alcance: 'provincial' });
      }
    }
  };

  async function buscarYoutube(query) {
    const url = `https://www.youtube.com/results?${new URLSearchParams({ search_query: query, hl: 'es', gl: 'EC' })}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(6500)
    });
    if (!response.ok) throw new Error(`YouTube search returned ${response.status}`);
    const html = await response.text();
    const marker = 'ytInitialData =';
    const markerAt = html.indexOf(marker);
    if (markerAt < 0) return [];
    const start = html.indexOf('{', markerAt + marker.length);
    if (start < 0) return [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = start;
    for (; end < html.length; end++) {
      const char = html[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end++; break; }
    }
    let initialData;
    try { initialData = JSON.parse(html.slice(start, end)); } catch { return []; }
    const videos = [];
    const stack = [initialData];
    while (stack.length && videos.length < 30) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) { stack.push(...value); continue; }
      if (value.videoId && /^[\w-]{11}$/.test(value.videoId)) {
        const title = value.title?.runs?.map(run => run.text || '').join('') || value.title?.simpleText || '';
        const channel = value.ownerText?.runs?.[0]?.text || value.shortBylineText?.runs?.[0]?.text || 'YouTube';
        const fecha = value.publishedTimeText?.simpleText || '';
        videos.push({ titulo: title, url: `https://www.youtube.com/watch?v=${value.videoId}`, fecha, fuente: channel, canal: channel, anio: (fecha.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '' });
      }
      stack.push(...Object.values(value));
    }
    return videos;
  }

  async function buscarGoogleNewsYoutube(query) {
    const url = new URL('https://news.google.com/rss/search');
    url.search = new URLSearchParams({ q: `site:youtube.com/watch ${query}`, hl: 'es-419', gl: 'EC', ceid: 'EC:es-419' }).toString();
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NoAIVerdad/1.0)' },
      signal: AbortSignal.timeout(5500)
    });
    if (!response.ok) throw new Error(`Google News RSS returned ${response.status}`);
    const xml = await response.text();
    const videos = [];
    for (const item of xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g) || []) {
      const titulo = xmlValue(item, 'title');
      const fecha = xmlValue(item, 'pubDate');
      const details = decodeXml(item);
      const candidates = details.match(/https?:[^\s"'<>]+/g) || [];
      const url = candidates.map(value => value.replace(/&amp;.*$/, '').replace(/[),.;]+$/, ''))
        .find(value => /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[\w-]{11}/i.test(value));
      if (!titulo || !url) continue;
      videos.push({ titulo, url, fecha, fuente: 'YouTube', canal: 'YouTube', anio: (fecha.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '' });
    }
    return videos;
  }

  await Promise.all(Array.from({ length: Math.min(8, queries.length) }, worker));
  const nationalVideos = await nationalPromise;
  for (const video of nationalVideos) {
    const text = normalize(`${video.titulo} ${video.descripcion || ''}`);
    if (!localTerms.some(term => term.length > 2 && text.includes(term)) || !isElectionRelevant(text) || seen.has(video.url)) continue;
    seen.add(video.url);
    results.push({ ...video, provincia: cacheKey, alcance: 'provincial' });
  }
  results.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
  const videos = results.slice(0, 60);
  if (videos.length) youtubeProvinceCache.set(cacheKey, { videos, expiresAt: Date.now() + 5 * 60 * 1000 });
  return videos;
}

async function getProvincialElectionNews(province) {
  const cacheKey = String(province || '').trim();
  const cached = provincialNewsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  const localities = PROVINCE_LOCALITIES[cacheKey] || [cacheKey];
  const queries = [...new Set(localities.flatMap(locality => [
    `elecciones 2027 ${locality} Ecuador`,
    `elecciones ${locality} Ecuador`,
    `CNE ${locality} elecciones`,
    `candidatos ${locality} elecciones Ecuador`
  ]))];
  const results = [];
  const seen = new Set();
  let nextQuery = 0;
  let successfulFeeds = 0;

  const worker = async () => {
    while (nextQuery < queries.length) {
      const query = queries[nextQuery++];
      try {
        const url = new URL('https://news.google.com/rss/search');
        url.search = new URLSearchParams({ q: query, hl: 'es-419', gl: 'EC', ceid: 'EC:es-419' }).toString();
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NoAIVerdad/1.0)' },
          signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) throw new Error(`Google News RSS returned ${response.status}`);
        successfulFeeds++;
        const xml = await response.text();
        for (const item of xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g) || []) {
          const title = xmlValue(item, 'title');
          const link = xmlValue(item, 'link');
          const fecha = xmlValue(item, 'pubDate');
          const fuente = xmlValue(item, 'source') || 'Google News';
          if (!title || !link || link === '#') continue;
          const identity = title.toLocaleLowerCase('es').trim();
          if (seen.has(identity)) continue;
          seen.add(identity);
          results.push({
            titulo: title, url: link, fecha, fuente,
            anio: (fecha.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '',
            alcance: 'provincial', provincia: cacheKey
          });
        }
      } catch (error) {
        console.warn(`[Google News RSS] Consulta local fallida para ${cacheKey}: ${error.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(5, queries.length) }, worker));
  if (!successfulFeeds) throw new Error(`Google News RSS no está disponible para ${cacheKey}`);
  results.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
  const items = results.slice(0, 80);
  provincialNewsCache.set(cacheKey, { items, expiresAt: Date.now() + (items.length ? 10 : 3) * 60 * 1000 });
  return items;
}

function stopLocalServices() {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = new Promise(resolve => {
    // OAuth popups and any other child windows must not keep Electron alive.
    for (const childWindow of auxiliaryWindows) {
      if (!childWindow.isDestroyed()) childWindow.destroy();
    }
    auxiliaryWindows.clear();

    const server = frontendServer;
    frontendServer = null;
    if (!server) return resolve();

    const sockets = [...frontendSockets];
    const finish = () => {
      frontendSockets.clear();
      resolve();
    };

    if (server.listening) server.close(finish);
    else finish();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
  });

  return shutdownPromise;
}

// Firebase Web Auth rejects file:// origins. Serve the packaged UI on a local
// HTTP origin so Google popup and Web Storage work in Electron.
function startFrontendServer() {
  const frontendRoot = path.resolve(app.getAppPath(), 'frontend');
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
    '.geojson': 'application/geo+json; charset=utf-8'
  };

  frontendServer = http.createServer((request, response) => {
    let pathname;
    let requestUrl;
    try {
      requestUrl = new URL(request.url, 'http://localhost');
      pathname = decodeURIComponent(requestUrl.pathname);
    }
    catch { response.writeHead(400).end('Bad request'); return; }

    if (pathname === '/api/noticias' && requestUrl.searchParams.get('seccion') === 'noticias') {
      const provincia = requestUrl.searchParams.get('provincia') || 'Ecuador';
      getProvincialElectionNews(provincia).then(noticias => {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
        });
        response.end(JSON.stringify({ provincia, tiempo_real: noticias, actualizado_en: new Date().toISOString() }));
      }).catch(error => {
        console.error(`[Google News RSS] No se pudo completar la búsqueda de ${provincia}: ${error.message}`);
        response.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
        });
        response.end(JSON.stringify({ tiempo_real: null, mensaje: 'No hay noticias por el momento.' }));
      });
      return;
    }

    if (pathname === '/api/noticias' && requestUrl.searchParams.get('seccion') === 'youtube') {
      const provincia = requestUrl.searchParams.get('provincia') || 'Ecuador';
      getProvincialYoutubeVideos(provincia).then(videos => {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
        });
        response.end(JSON.stringify({
          provincia,
          youtube_videos: videos
        }));
      }).catch(() => {
        response.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
        });
        response.end(JSON.stringify({ youtube_videos: null, mensaje: 'No hay noticias por el momento.' }));
      });
      return;
    }

    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(frontendRoot, requested);
    if (filePath !== frontendRoot && !filePath.startsWith(frontendRoot + path.sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) { response.writeHead(404).end('Not found'); return; }
      response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
      });
      response.end(content);
    });
  });
  frontendServer.on('connection', socket => {
    frontendSockets.add(socket);
    socket.once('close', () => frontendSockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    frontendServer.once('error', reject);
    frontendServer.listen(0, 'localhost', () => {
      frontendServer.removeListener('error', reject);
      resolve(`http://localhost:${frontendServer.address().port}/`);
    });
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: "NoAIVerdad - Plataforma Cívica para Monitoreo Electoral en Ecuador",
    icon: path.join(__dirname, '../frontend/img/icon.png'),
    backgroundColor: '#0b0f19',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  // Cargar la interfaz desde HTTP en vez de file:// para habilitar Firebase Auth.
  const frontendUrl = await startFrontendServer();
  console.log(`[Electron] Cargando interfaz desde ${frontendUrl}`);
  mainWindow.loadURL(frontendUrl);
  mainWindow.webContents.once('did-finish-load', async () => {
    const pageUrl = await mainWindow.webContents.executeJavaScript('window.location.href');
    console.log(`[Electron] Origen activo: ${pageUrl}`);
  });

  // Firebase necesita que su OAuth popup permanezca vinculado a esta ventana.
  // Enviar ese handler al navegador externo rompe el opener y pierde el estado.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let target;
    try { target = new URL(url); } catch { return { action: 'deny' }; }

    if (
      target.origin === FIREBASE_AUTH_HANDLER_ORIGIN &&
      target.pathname.startsWith('/__/auth/')
    ) {
      console.log(`[Electron] Permitiendo popup Firebase: ${target.pathname}`);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 650,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            session: mainWindow.webContents.session
          }
        }
      };
    }

    // Abrir los demás enlaces externos en el navegador predeterminado.
    console.log(`[Electron] Abriendo enlace externo: ${url}`);
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (popup, details) => {
    auxiliaryWindows.add(popup);
    popup.once('closed', () => auxiliaryWindows.delete(popup));
    console.log(`[Electron] Popup creado: ${details.url}`);
  });

  // Menú superior nativo de la aplicación
  const menuTemplate = [
    {
      label: 'Archivo',
      submenu: [
        { label: 'Reiniciar aplicación', role: 'reload' },
        { label: 'Forzar recarga', role: 'forceReload' },
        { type: 'separator' },
        { label: 'Salir', role: 'quit' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { label: 'Pantalla completa', role: 'togglefullscreen' },
        { label: 'Acercar zoom', role: 'zoomIn' },
        { label: 'Alejar zoom', role: 'zoomOut' },
        { label: 'Restablecer zoom', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Herramientas de Desarrollador', role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Repositorio GitHub',
          click: () => shell.openExternal('https://github.com/Katthon/NoAIVerdad')
        },
        {
          label: 'Acerca de NoAIVerdad',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript(`
                document.getElementById('nav-btn-acerca')?.click();
              `);
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  mainWindow.on('close', () => {
    stopLocalServices();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

// Inicialización de la aplicación
app.whenReady().then(() => {
  createWindow().catch(error => {
    console.error('[Electron] No se pudo iniciar la ventana:', error);
    stopLocalServices();
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  stopLocalServices()
    .catch(error => console.error('[Electron] Error cerrando servicios locales:', error))
    .then(() => {
      shutdownComplete = true;
      app.quit();
    });
});
