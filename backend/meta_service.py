import re
import requests
import logging
import xml.etree.ElementTree as ET
import unicodedata
import time
import threading
from datetime import datetime, timezone
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any
import firebase_store
from ads_library import AdLibraryClient

# Configurar logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _anio_de_fecha(value: str) -> str:
    match = re.search(r"\b(19\d{2}|20\d{2})\b", str(value or ""))
    return match.group(1) if match else ""


def _texto_normalizado(value: str) -> str:
    value = unicodedata.normalize("NFD", str(value or "").casefold())
    return "".join(char for char in value if unicodedata.category(char) != "Mn")


PROVINCIA_LOCALIDADES = {
    "Azuay": ["Azuay", "Cuenca", "Gualaceo"],
    "Bolívar": ["Bolívar Ecuador", "Guaranda", "San Miguel Bolívar"],
    "Cañar": ["Cañar", "Azogues", "La Troncal"],
    "Carchi": ["Carchi", "Tulcán", "Montúfar"],
    "Chimborazo": ["Chimborazo", "Riobamba", "Alausí"],
    "Cotopaxi": ["Cotopaxi", "Latacunga", "La Maná"],
    "El Oro": ["El Oro Ecuador", "Machala", "Santa Rosa El Oro"],
    "Esmeraldas": ["Esmeraldas Ecuador", "Quinindé", "Atacames"],
    "Galápagos": ["Galápagos", "Puerto Ayora", "San Cristóbal Galápagos"],
    "Guayas": ["Guayas", "Guayaquil", "Durán"],
    "Imbabura": ["Imbabura", "Ibarra", "Otavalo"],
    "Loja": ["Loja Ecuador", "Catamayo", "Macará"],
    "Los Ríos": ["Los Ríos Ecuador", "Babahoyo", "Quevedo"],
    "Manabí": ["Manabí", "Portoviejo", "Manta"],
    "Morona Santiago": ["Morona Santiago", "Macas", "Gualaquiza"],
    "Napo": ["Napo Ecuador", "Tena", "Archidona"],
    "Orellana": ["Orellana Ecuador", "El Coca", "Francisco de Orellana"],
    "Pastaza": ["Pastaza Ecuador", "Puyo", "Mera"],
    "Pichincha": ["Pichincha", "Quito", "Cayambe"],
    "Santa Elena": ["Santa Elena Ecuador", "Salinas", "La Libertad Ecuador"],
    "Santo Domingo de los Tsáchilas": ["Santo Domingo Ecuador", "Santo Domingo de los Tsáchilas", "La Concordia"],
    "Sucumbíos": ["Sucumbíos", "Lago Agrio", "Nueva Loja"],
    "Tungurahua": ["Tungurahua", "Ambato", "Baños Ecuador"],
    "Zamora Chinchipe": ["Zamora Chinchipe", "Zamora Ecuador", "Yantzaza"],
}
TERMINOS_ELECTORALES = [
    "elecciones", "elección", "electoral", "CNE", "votación", "voto", "votar",
    "sufragio", "candidato", "candidata", "candidatos", "candidatas",
    "candidatura", "campaña", "presidencial", "consulta popular", "referéndum",
    "escrutinio", "papeleta", "urna", "segunda vuelta", "precandidato",
    "precandidata", "Consejo Nacional Electoral", "elecciones 2027", "política",
    "político", "presidente de Ecuador", "gobierno de Ecuador", "Asamblea Nacional",
    "asambleísta", "alcalde", "prefecto", "Noboa", "reforma", "seguridad",
]

class UnifiedFeedService:
    """
    Servicio unificado que consulta de manera SIMULTÁNEA / CONCURRENTE:
    1. Noticias en tiempo real (GNews API + Google News RSS en vivo sin cuota)
    2. Revisiones e información cívica (Google Fact Check Tools API - SIN etiquetas Falso/Verdadero)
    3. Bluesky público. X se mantiene desactivado.
    
    100% libre de datos quemados o sintéticos.
    """

    GNEWS_URL = "https://gnews.io/api/v4/search"
    FACT_CHECK_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search"
    META_GRAPH_API_VERSION = "v26.0"
    META_INTEGRATION_ENABLED = False  # Oculta/desactiva Meta hasta que el usuario lo solicite.

    def __init__(self):
        self.gnews_api_key = ""
        self.fact_check_api_key = ""
        self.x_api_bearer_token = ""
        self.x_api_enabled = False
        self.meta_access_token = ""
        self.meta_api_enabled = False
        self.grok_api_key = ""
        self.bluesky_handle = ""
        self.bluesky_app_password = ""
        self._reddit_rss_cache = {}
        self._reddit_rss_lock = threading.Lock()
        self._youtube_channel_cache = {}
        self._youtube_cache_expiry = 0
        self.ads_library = AdLibraryClient()
        self.reload_api_keys()
        self.scraper = None

    def reload_api_keys(self) -> dict[str, bool]:
        """Reload provider credentials from Firebase; never read them from frontend or .env."""
        keys = firebase_store.get_api_keys()
        self.gnews_api_key = keys.get("GNEWS_API_KEY", "")
        self.fact_check_api_key = keys.get("GOOGLE_FACT_CHECK_API_KEY", "")
        # X/Twitter is intentionally disabled: do not make paid API calls or
        # unreliable scraper requests, even if old credentials remain in Firebase.
        self.x_api_bearer_token = ""
        self.x_api_enabled = False
        self.meta_access_token = keys.get("FB_META_ACCESS_TOKEN", "")
        if hasattr(self, "ads_library"):
            self.ads_library.reload_token()
        self.meta_api_enabled = (
            self.META_INTEGRATION_ENABLED
            and keys.get("FB_META_API_ENABLED", "false").lower() == "true"
        )
        self.grok_api_key = keys.get("GROK_API_KEY", "")
        self.bluesky_handle = keys.get("BLUESKY_HANDLE", "")
        self.bluesky_app_password = keys.get("BLUESKY_APP_PASSWORD", "")
        return {name: bool(value) for name, value in keys.items()}

    def obtener_feed_por_seccion(self, provincia: str, seccion: str) -> Dict[str, Any]:
        """
        Obtiene ÚNICAMENTE la sección solicitada de forma ultra rápida (on-demand):
        - 'noticias': Noticias de prensa en tiempo real
        - 'verificaciones': Revisiones de Google Fact Check
        - 'tweets': Publicaciones de X (Twitter)
        - 'bluesky': Publicaciones en vivo de Bluesky (AT Protocol)
        - 'meta_ads': Anuncios de Meta (Facebook / Instagram Ad Library API)
        """
        res = {
            "provincia": provincia,
            "tiempo_real": [],
            "verificaciones": [],
            "tweets_recientes": [],
            "bluesky_posts": [],
            "youtube_videos": [],
            "reddit_posts": [],
            "meta_ads": []
        }

        seccion_lower = (seccion or "").lower().strip()

        if seccion_lower == "noticias":
            res["tiempo_real"] = self.obtener_noticias_reales(provincia)
        elif seccion_lower == "verificaciones":
            res["verificaciones"] = self.obtener_verificaciones_con_rating(provincia)
        elif seccion_lower == "tweets":
            res["tweets_recientes"] = self.obtener_tweets_reales(provincia)
        elif seccion_lower == "bluesky":
            res["bluesky_posts"] = self.obtener_posts_bluesky(provincia)
        elif seccion_lower == "youtube":
            res["youtube_videos"] = self.obtener_videos_youtube(provincia)
        elif seccion_lower == "reddit":
            res["reddit_posts"] = self.obtener_posts_reddit(provincia)
        elif seccion_lower == "meta_ads":
            # Meta stays dormant until the integration is explicitly enabled.
            if self.META_INTEGRATION_ENABLED and self.meta_api_enabled:
                res["meta_ads"] = self.obtener_anuncios_meta(provincia)
        else:
            return self.obtener_feed_completo(provincia)

        return res

    def obtener_feed_completo(self, provincia: str) -> Dict[str, Any]:
        """
        Ejecuta las 5 consultas EN PARALELO usando ThreadPoolExecutor.
    (Prensa + revisiones Fact-Check + X cuando hay resultados + Bluesky + páginas Facebook autorizadas)
        """
        with ThreadPoolExecutor(max_workers=7) as executor:
            future_news = executor.submit(self.obtener_noticias_reales, provincia)
            future_factcheck = executor.submit(self.obtener_verificaciones_con_rating, provincia)
            future_twitter = executor.submit(self.obtener_tweets_reales, provincia)
            future_bluesky = executor.submit(self.obtener_posts_bluesky, provincia)
            future_meta = (
                executor.submit(self.obtener_anuncios_meta, provincia)
                if self.META_INTEGRATION_ENABLED and self.meta_api_enabled
                else None
            )
            future_youtube = executor.submit(self.obtener_videos_youtube, provincia)

            noticias = future_news.result()
            verificaciones = future_factcheck.result()
            tweets = future_twitter.result()
            bluesky = future_bluesky.result()
            meta_ads = future_meta.result() if future_meta else []
            youtube = future_youtube.result()
            # Reddit is searched on demand to avoid querying all 24 provinces
            # during the background collection cycle.
            reddit = []

        return {
            "provincia": provincia,
            "tiempo_real": noticias,
            "verificaciones": verificaciones,
            "tweets_recientes": tweets,
            "bluesky_posts": bluesky,
            "meta_ads": meta_ads,
            "youtube_videos": youtube,
            "reddit_posts": reddit
        }

    def obtener_videos_youtube(self, provincia: str) -> List[Dict[str, Any]]:
        """Collect recent election-related uploads from major Ecuadorian news channels via public YouTube RSS."""
        channels = {
            "Ecuavisa": "UCRUV3nUNSc-xpBrTwQOCQQg",
            "Teleamazonas": "UCCwRtme3lumNRQXMO2EvCvw",
            "Primicias": "UCe6Gi8_PZp9gcEZb5hTCPdQ",
            "TC Televisión": "UCMDsWeFwRQ5BRzNLFzpc-ew",
            "Ecuador TV": "UCfXVS_zw_XmAx8iIiia1IkA",
        }
        now = time.time()
        if now >= self._youtube_cache_expiry:
            videos = []
            headers = {"User-Agent": "Mozilla/5.0 (compatible; NoAIVerdad/1.0)"}
            for name, channel_id in channels.items():
                try:
                    feed = requests.get("https://www.youtube.com/feeds/videos.xml", params={"channel_id": channel_id}, headers=headers, timeout=8)
                    feed.raise_for_status()
                    root = ET.fromstring(feed.content)
                    ns = {"atom": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}
                    for entry in root.findall("atom:entry", ns):
                        title = entry.findtext("atom:title", "", ns)
                        video_id = entry.findtext("yt:videoId", "", ns)
                        published = entry.findtext("atom:published", "", ns)
                        if not video_id:
                            continue
                        videos.append({"titulo": title, "url": f"https://www.youtube.com/watch?v={video_id}", "fecha": published, "fuente": name, "canal": name, "anio": _anio_de_fecha(published)})
                except Exception as exc:
                    logger.info("[YouTube RSS] No se pudo consultar %s: %s", name, exc)
            self._youtube_channel_cache = videos
            # No guardar el vacío como si fuera válido durante 15 minutos: un
            # bloqueo temporal de RSS no debe ocultar videos provinciales.
            self._youtube_cache_expiry = now + (900 if videos else 30)
        return list(self._youtube_channel_cache)

    def obtener_posts_reddit(self, provincia: str) -> List[Dict[str, Any]]:
        """Busca conversaciones públicas de Reddit con consultas locales amplias."""
        provincia = str(provincia or "").strip()
        if not provincia:
            return []

        cache_key = _texto_normalizado(provincia)
        now = time.time()
        with self._reddit_rss_lock:
            cached = self._reddit_rss_cache.get(cache_key)
            if cached and cached["expires_at"] > now:
                return list(cached["posts"])

        localidades = next(
            (values for nombre, values in PROVINCIA_LOCALIDADES.items()
             if _texto_normalizado(nombre) == cache_key),
            [provincia],
        )
        # Reddit RSS puede interpretar de forma restrictiva comillas, OR y
        # paréntesis. Usar frases sencillas mejora la cobertura y además
        # permite incluir asuntos electorales discutidos sin nombrar la ciudad
        # en el título. La provincia se conserva como foco de búsqueda.
        consultas = list(dict.fromkeys(
            f"{localidad} {tema}"
            for localidad in localidades
            for tema in (
                "elecciones Ecuador", "politica Ecuador", "CNE Ecuador",
                "candidatos Ecuador", "presidente Ecuador",
            )
        ))
        consultas.extend([
            f"elecciones Ecuador {provincia}",
            f"elecciones Ecuador {provincia} 2027",
            f"politica ecuatoriana {provincia}",
        ])
        consultas = list(dict.fromkeys(consultas))
        headers = {
            "User-Agent": "NoAIVerdad/1.0 (public Reddit RSS reader)",
            "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml",
        }
        posts_por_url = {}
        election_terms = [
            "eleccion", "electoral", "cne", "candidat", "campan", "vot",
            "sufrag", "urna", "papeleta", "prefect", "alcald", "concej",
            "politic", "president", "noboa", "asamblea", "referendum",
            "consulta popular", "escrutinio", "debate electoral",
        ]
        def buscar_rss(query: str):
            try:
                response = requests.get(
                    "https://www.reddit.com/search.rss",
                    params={"q": query, "sort": "new", "limit": 100},
                    headers=headers,
                    timeout=10,
                )
                response.raise_for_status()
                root = ET.fromstring(response.content)
                namespace = "{http://www.w3.org/2005/Atom}"
                encontrados = []
                for entry in root.findall(f"{namespace}entry"):
                    title_node = entry.find(f"{namespace}title")
                    link_node = entry.find(f"{namespace}link")
                    date_node = entry.find(f"{namespace}updated")
                    if date_node is None:
                        date_node = entry.find(f"{namespace}published")
                    summary_node = entry.find(f"{namespace}content")
                    if summary_node is None:
                        summary_node = entry.find(f"{namespace}summary")
                    titulo = (title_node.text or "").strip() if title_node is not None else ""
                    url = link_node.get("href", "") if link_node is not None else ""
                    fecha = (date_node.text or "").strip() if date_node is not None else ""
                    summary = (summary_node.text or "").strip() if summary_node is not None else ""
                    if not titulo or not url or urlparse(url).hostname not in {"reddit.com", "www.reddit.com", "old.reddit.com"}:
                        continue
                    normalized_text = _texto_normalizado(f"{titulo} {summary}")
                    if not any(term in normalized_text for term in election_terms):
                        continue
                    categories = entry.findall(f"{namespace}category")
                    subreddit = next((item.get("term", "") for item in categories if item.get("term", "").startswith("r/")), "Reddit")
                    clean_summary = re.sub(r"<[^>]*>", " ", summary)
                    clean_summary = re.sub(r"\s+", " ", clean_summary).strip()
                    encontrados.append({
                        "titulo": titulo,
                        "text": clean_summary,
                        "url": url,
                        "fecha": fecha,
                        "fuente": subreddit,
                        "anio": _anio_de_fecha(fecha),
                        "alcance": "provincial",
                        "provincia": provincia,
                    })
                return encontrados
            except Exception as exc:
                logger.info("[Reddit RSS] Falló consulta '%s': %s", query, exc)
                return []

        with ThreadPoolExecutor(max_workers=8) as executor:
            for encontrados in executor.map(buscar_rss, consultas):
                for post in encontrados:
                    posts_por_url.setdefault(post["url"], post)

        posts = sorted(posts_por_url.values(), key=lambda post: post.get("fecha", ""), reverse=True)[:100]
        with self._reddit_rss_lock:
            self._reddit_rss_cache[cache_key] = {
                "posts": posts,
                "expires_at": time.time() + (600 if posts else 60),
            }
        logger.info("[Reddit RSS] %s publicaciones públicas electorales para %s.", len(posts), provincia)
        return posts

    # =========================================================================
    # 1. NOTICIAS EN TIEMPO REAL (GNews API + Google News RSS en vivo)
    # =========================================================================
    def obtener_noticias_reales(self, provincia: str) -> List[Dict[str, Any]]:
        noticias = []

        # Intento A: GNews API si existe clave configurada
        if self.gnews_api_key:
            try:
                query = f"elecciones {provincia} Ecuador"
                params = {
                    "q": query,
                    "lang": "es",
                    "country": "ec",
                    "max": 10,
                    "apikey": self.gnews_api_key
                }
                logger.info(f"[GNews API] Consultando noticias reales: '{query}'...")
                resp = requests.get(self.GNEWS_URL, params=params, timeout=7)
                if resp.status_code == 200:
                    articles = resp.json().get("articles", [])
                    for art in articles:
                        title = art.get("title")
                        url = art.get("url")
                        if not title or not url or url == "#":
                            continue
                        source_name = art.get("source", {}).get("name") or urlparse(url).hostname or ""
                        noticias.append({
                            "titulo": title,
                            "url": url,
                            "fecha": art.get("publishedAt", ""),
                            "fuente": source_name,
                            "anio": _anio_de_fecha(art.get("publishedAt", "")),
                        })
            except Exception as e:
                logger.error(f"[GNews API] Error: {e}")

        # Combinar GNews con búsquedas locales de Google News para ampliar la
        # cobertura y evitar que todas las provincias compartan los mismos 10 titulares.
        noticias.extend(self._obtener_google_news_rss(provincia))

        # Deduplicar fuentes combinadas sin descartar titulares antiguos válidos.
        merged = []
        seen = set()
        for item in noticias:
            identity = str(item.get("url") or item.get("titulo") or "").strip().lower()
            if identity and identity not in seen:
                seen.add(identity)
                merged.append(item)
        noticias = merged

        # El CNE es una fuente primaria y se añade a la prensa agregada.
        known_urls = {item.get("url") for item in noticias if item.get("url")}
        noticias.extend(item for item in self._obtener_cne_rss() if item.get("url") not in known_urls)

        return noticias

    def _obtener_cne_rss(self) -> List[Dict[str, Any]]:
        """Fetch official CNE newsroom posts through the site's WordPress RSS feed."""
        for rss_url in ("https://www.cne.gob.ec/category/noticias/feed/", "https://www.cne.gob.ec/feed/"):
            try:
                response = requests.get(rss_url, headers={"User-Agent": "NoAIVerdad/1.0"}, timeout=8)
                if response.status_code != 200:
                    continue
                root = ET.fromstring(response.content)
                result = []
                for item in root.findall(".//item")[:30]:
                    title = item.findtext("title", "")
                    link = item.findtext("link", "")
                    pub_date = item.findtext("pubDate", "")
                    if title and link:
                        result.append({"titulo": title, "url": link, "fecha": pub_date, "fuente": "CNE Ecuador", "anio": _anio_de_fecha(pub_date)})
                if result:
                    return result
            except Exception as exc:
                logger.info("[CNE RSS] No se pudo consultar el feed: %s", exc)
        return []

    def _obtener_google_news_rss(self, provincia: str) -> List[Dict[str, Any]]:
        """Busca titulares electorales en las principales localidades provinciales."""
        localidades = PROVINCIA_LOCALIDADES.get(provincia, [provincia])
        queries = list(dict.fromkeys(
            query
            for localidad in localidades
            for query in (
                f"elecciones 2027 {localidad} Ecuador",
                f"elecciones {localidad} Ecuador",
                f"CNE {localidad} elecciones",
                f"candidatos {localidad} elecciones Ecuador",
            )
        ))
        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }

        def buscar(q: str):
            try:
                rss_url = "https://news.google.com/rss/search"
                logger.info("[Google News RSS] Consulta local %s: '%s'.", provincia, q)
                resp = requests.get(rss_url, params={"q": q, "hl": "es-419", "gl": "EC", "ceid": "EC:es-419"}, headers=headers, timeout=8)
                resp.raise_for_status()
                root = ET.fromstring(resp.content)
                result = []
                for item in root.findall(".//item")[:10]:
                    title = item.findtext("title", "")
                    link = item.findtext("link", "")
                    pub_date = item.findtext("pubDate", "")
                    source_elem = item.find("source")
                    fuente = source_elem.text if source_elem is not None else "Google News"
                    if title and link:
                        result.append({
                            "titulo": title, "url": link, "fecha": pub_date,
                            "fuente": fuente, "anio": _anio_de_fecha(pub_date),
                            "alcance": "provincial", "provincia": provincia,
                        })
                return result
            except Exception as e:
                logger.info("[Google News RSS] Falló '%s' para %s: %s", q, provincia, e)
                return []

        with ThreadPoolExecutor(max_workers=5) as executor:
            feeds = executor.map(buscar, queries)
            noticias_rss = [item for feed in feeds for item in feed]

        unique = {}
        for item in noticias_rss:
            identity = (item.get("titulo") or "").strip().casefold()
            if identity:
                unique.setdefault(identity, item)
        result = list(unique.values())
        result.sort(key=lambda item: item.get("fecha", ""), reverse=True)
        return result[:80]

    # =========================================================================
    # 2. INFORMACIÓN CÍVICA Y VERIFICACIONES (Google Fact Check Tools API)
    #    Incluye la clasificación original (textualRating) para advertencias en la UI.
    # =========================================================================
    def obtener_verificaciones_con_rating(self, provincia: str) -> List[Dict[str, Any]]:
        verificaciones = []
        if not self.fact_check_api_key:
            logger.warning("Google Fact Check deshabilitado: GOOGLE_FACT_CHECK_API_KEY no configurada.")
            return []

        queries = [f"{provincia} elecciones Ecuador", f"Ecuador elecciones {provincia}", "Ecuador elecciones"]

        for q in queries:
            try:
                params = {
                    "query": q,
                    "languageCode": "es",
                    "key": self.fact_check_api_key
                }
                logger.info(f"[Google Fact Check] Consultando revisiones: '{q}'...")
                resp = requests.get(self.FACT_CHECK_URL, params=params, timeout=7)
                if resp.status_code == 200:
                    claims = resp.json().get("claims", [])
                    for claim in claims:
                        text = claim.get("text", "")
                        claimant = claim.get("claimant", "")
                        reviews = claim.get("claimReview", [])
                        rev = reviews[0] if reviews else {}
                        review_url = rev.get("url", "")
                        publisher = rev.get("publisher", {}).get("name", "")
                        if not text or not review_url or not publisher:
                            continue

                        verificaciones.append({
                            "text": text,
                            "claimant": claimant,
                            "url": review_url,
                            "publisher": publisher,
                            "textualRating": rev.get("textualRating", ""),
                            "anio": _anio_de_fecha(rev.get("reviewDate", "")),
                        })
                    if verificaciones:
                        break
            except Exception as e:
                logger.error(f"[Google Fact Check] Error: {e}")

        return verificaciones

    # =========================================================================
    # 3. PUBLICACIONES EN X: API OFICIAL, CON NITTER COMO RESPALDO NO OFICIAL
    # =========================================================================
    def obtener_tweets_reales(self, provincia: str) -> List[Dict[str, Any]]:
        logger.info("X está desactivado; se omite la búsqueda para %s.", provincia)
        return []

    # =========================================================================
    # 4. PUBLICACIONES EN BLUESKY (POSTS REALES VÍA AT PROTOCOL SEARCH API)
    # =========================================================================
    BLUESKY_SEARCH_POSTS_API = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts"

    def obtener_posts_bluesky(self, provincia: str) -> List[Dict[str, Any]]:
        """
        Consulta publicaciones REALES que mencionan la provincia o ciudades locales.
        Usa la API pública oficial de búsqueda de Bluesky, sin consultas nacionales genéricas.
        - CERO perfiles genéricos, CERO datos sintéticos.
        """
        # Variar los términos temáticos por provincia/localidad permite ampliar
        # los resultados sin rellenar cada feed con las mismas menciones nacionales.
        localidades = PROVINCIA_LOCALIDADES.get(provincia, [provincia])
        temas = [
            "elecciones", "electoral", "CNE", "candidatos", "votación",
            "campaña electoral", "consulta popular", "elecciones 2027",
        ]
        queries = list(dict.fromkeys(
            f'"{localidad}" {tema}'
            for localidad in localidades
            for tema in temas
        ))
        localidades_normalizadas = [_texto_normalizado(value) for value in localidades]
        terminos_electorales_normalizados = [_texto_normalizado(value) for value in TERMINOS_ELECTORALES]
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        seen_uris = set()
        posts_bluesky = []
        since = datetime.now(timezone.utc).strftime("%Y-01-01T00:00:00Z")

        def buscar(q: str):
            try:
                resp = requests.get(
                    self.BLUESKY_SEARCH_POSTS_API,
                    params={"q": q, "limit": 100, "sort": "latest", "since": since},
                    headers=headers,
                    timeout=8,
                )
                if resp.status_code != 200:
                    logger.warning("[Bluesky Public API] HTTP %d para consulta '%s'.", resp.status_code, q)
                    return q, []
                return q, resp.json().get("posts", [])
            except Exception:
                logger.warning("[Bluesky Public API] Error consultando '%s'.", q)
                return q, []

        # Consultas paralelas: amplían cobertura sin sumar hasta 8 timeouts en serie.
        with ThreadPoolExecutor(max_workers=4) as executor:
            for q, posts_raw in executor.map(buscar, queries):
                logger.info("[Bluesky Public API] Procesando '%s' (%d resultados).", q, len(posts_raw))
                for p in posts_raw:
                    uri = p.get("uri", "")
                    if not uri or uri in seen_uris:
                        continue
                    seen_uris.add(uri)

                    rec = p.get("record", {})
                    text = rec.get("text", "")
                    if not text or len(text) < 8:
                        continue
                    texto_local = _texto_normalizado(text)
                    if not any(
                        re.search(r"(?<![a-z0-9])" + re.escape(localidad) + r"(?![a-z0-9])", texto_local)
                        for localidad in localidades_normalizadas
                    ):
                        continue
                    if not any(
                        re.search(r"(?<![a-z0-9])" + re.escape(termino) + r"(?![a-z0-9])", texto_local)
                        for termino in terminos_electorales_normalizados
                    ):
                        continue

                    auth = p.get("author", {})
                    post_handle = auth.get("handle", "")
                    if not post_handle:
                        continue
                    display_name = auth.get("displayName") or post_handle
                    rkey = uri.split("/")[-1]
                    post_url = f"https://bsky.app/profile/{post_handle}/post/{rkey}"
                    date_str = rec.get("createdAt") or p.get("indexedAt") or ""
                    posts_bluesky.append({
                        "text": text,
                        "author": {
                            "name": display_name,
                            "handle": f"@{post_handle}",
                            "avatar": auth.get("avatar", "")
                        },
                        "date": date_str,
                        "link": post_url,
                        "stats": {
                            "likes": p.get("likeCount", 0),
                            "reposts": p.get("repostCount", 0),
                            "replies": p.get("replyCount", 0),
                            "quotes": p.get("quoteCount", 0)
                        },
                        "anio": _anio_de_fecha(date_str),
                        "alcance": "provincial",
                    })
        posts_bluesky.sort(key=lambda post: post.get("date", ""), reverse=True)
        return posts_bluesky[:200]

    # =========================================================================
    # 5. PUBLICACIONES Y ANUNCIOS EN META (FACEBOOK / INSTAGRAM POSTS & ADS)
    # =========================================================================
    def obtener_anuncios_meta(self, provincia: str) -> List[Dict[str, Any]]:
        """Obtiene anuncios políticos de Meta Ad Library con inversión y alcance estimados."""
        if not self.META_INTEGRATION_ENABLED or not self.meta_api_enabled:
            return []
        ads, _estado = self.ads_library.por_provincia(provincia)
        return ads
