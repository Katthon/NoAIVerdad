import re
import requests
import logging
import xml.etree.ElementTree as ET
import unicodedata
from datetime import datetime, timezone
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any
import firebase_store

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
    "precandidata", "Consejo Nacional Electoral", "elecciones 2027",
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
        elif seccion_lower == "meta_ads":
            res["meta_ads"] = self.obtener_anuncios_meta(provincia)
        else:
            return self.obtener_feed_completo(provincia)

        return res

    def obtener_feed_completo(self, provincia: str) -> Dict[str, Any]:
        """
        Ejecuta las 5 consultas EN PARALELO usando ThreadPoolExecutor.
    (Prensa + revisiones Fact-Check + X cuando hay resultados + Bluesky + páginas Facebook autorizadas)
        """
        with ThreadPoolExecutor(max_workers=5) as executor:
            future_news = executor.submit(self.obtener_noticias_reales, provincia)
            future_factcheck = executor.submit(self.obtener_verificaciones_con_rating, provincia)
            future_twitter = executor.submit(self.obtener_tweets_reales, provincia)
            future_bluesky = executor.submit(self.obtener_posts_bluesky, provincia)
            future_meta = executor.submit(self.obtener_anuncios_meta, provincia)

            noticias = future_news.result()
            verificaciones = future_factcheck.result()
            tweets = future_twitter.result()
            bluesky = future_bluesky.result()
            meta_ads = future_meta.result()

        return {
            "provincia": provincia,
            "tiempo_real": noticias,
            "verificaciones": verificaciones,
            "tweets_recientes": tweets,
            "bluesky_posts": bluesky,
            "meta_ads": meta_ads
        }

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

        # Intento B: Si GNews no devuelve datos, usar Google News RSS en vivo
        if not noticias:
            noticias = self._obtener_google_news_rss(provincia)

        return noticias

    def _obtener_google_news_rss(self, provincia: str) -> List[Dict[str, Any]]:
        """Extrae noticias reales en tiempo real del RSS de Google News Ecuador sin límites de cuota."""
        noticias_rss = []
        queries = [
            f"elecciones {provincia} Ecuador", 
            f"elecciones Ecuador {provincia}", 
            f"{provincia} Ecuador noticias",
            "elecciones Ecuador"
        ]

        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }

        for q in queries:
            rss_url = f"https://news.google.com/rss/search?q={requests.utils.quote(q)}&hl=es-419&gl=EC&ceid=EC:es-419"
            try:
                logger.info(f"[Google News RSS] Consultando feed en vivo: '{q}'...")
                resp = requests.get(rss_url, headers=headers, timeout=6)
                if resp.status_code == 200:
                    root = ET.fromstring(resp.content)
                    items = root.findall(".//item")
                    for item in items[:10]:
                        title = item.findtext("title", "")
                        link = item.findtext("link", "#")
                        pubDate = item.findtext("pubDate", "")
                        source_elem = item.find("source")
                        fuente = source_elem.text if source_elem is not None else "Prensa Ecuador"

                        if not title or not link or link == "#":
                            continue
                        noticias_rss.append({
                            "titulo": title,
                            "url": link,
                            "fecha": pubDate,
                            "fuente": fuente,
                            "anio": _anio_de_fecha(pubDate)
                        })
                    if noticias_rss:
                        break
            except Exception as e:
                logger.error(f"[Google News RSS] Error en RSS: {e}")

        return noticias_rss

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
        """Obtiene publicaciones reales de páginas de Facebook administradas por la cuenta."""
        posts_meta = []
        if not self.meta_api_enabled or not self.meta_access_token:
            return posts_meta

        try:
            accounts = requests.get(
                f"https://graph.facebook.com/{self.META_GRAPH_API_VERSION}/me/accounts",
                params={"fields": "id,name,access_token"},
                headers={"Authorization": f"Bearer {self.meta_access_token}"},
                timeout=8,
            )
            accounts.raise_for_status()
            page_accounts = accounts.json().get("data", [])
            logger.info("[Meta Graph API] Token válido; páginas accesibles: %d.", len(page_accounts))
            for account in page_accounts:
                page_id = account.get("id")
                page_name = account.get("name", "")
                page_token = account.get("access_token") or self.meta_access_token
                if not page_id:
                    continue

                response = requests.get(
                    f"https://graph.facebook.com/{self.META_GRAPH_API_VERSION}/{page_id}/published_posts",
                    params={
                        "limit": 25,
                        "fields": "message,story,created_time,permalink_url",
                    },
                    headers={"Authorization": f"Bearer {page_token}"},
                    timeout=8,
                )
                response.raise_for_status()
                for post in response.json().get("data", []):
                    message = (post.get("message") or post.get("story") or "").strip()
                    permalink = post.get("permalink_url", "")
                    created = post.get("created_time", "")
                    if not message or not permalink:
                        continue
                    if _texto_normalizado(provincia) not in _texto_normalizado(message):
                        continue
                    posts_meta.append({
                        "text": message,
                        "page_name": page_name,
                        "date": created,
                        "link": permalink,
                        "anio": _anio_de_fecha(created),
                    })
            logger.info("[Meta Graph API] Publicaciones coincidentes con %s: %d.", provincia, len(posts_meta))
        except Exception:
            # Requests' HTTPError text can include URL query parameters. Never log it.
            logger.warning("[Meta Graph API] No se pudieron obtener publicaciones (red o permisos).")

        return posts_meta
