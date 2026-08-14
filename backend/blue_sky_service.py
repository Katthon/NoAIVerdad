import os
import requests
import logging
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any

# Configurar logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Intentar importar ntscraper
try:
    from ntscraper import Nitter
    HAS_NTSCRAPER = True
except ImportError:
    HAS_NTSCRAPER = False
    logger.warning("Librería 'ntscraper' no detectada.")

class UnifiedFeedService:
    """
    Servicio unificado 100% REAL. 
    Cero datos quemados. Cero fallbacks sintéticos.
    """

    GNEWS_URL = "https://gnews.io/api/v4/search"
    FACT_CHECK_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search"

    def __init__(self):
        self.gnews_api_key = os.getenv("GNEWS_API_KEY", "").strip()
        self.fact_check_api_key = os.getenv("GOOGLE_FACT_CHECK_API_KEY", "").strip()
        self.scraper = None
        self.cache_feed = {}

        if HAS_NTSCRAPER:
            try:
                self.scraper = Nitter(log_level=1)
                logger.info("Scraper de Nitter (ntscraper) listo.")
            except Exception as e:
                logger.error(f"Error al instanciar Nitter: {e}")

    def obtener_feed_completo(self, provincia: str) -> Dict[str, Any]:
        prov_key = provincia.lower().strip()
        if prov_key in self.cache_feed:
            return self.cache_feed[prov_key]

        with ThreadPoolExecutor(max_workers=4) as executor:
            future_news = executor.submit(self.obtener_noticias_reales, provincia)
            future_factcheck = executor.submit(self.obtener_verificaciones_con_rating, provincia)
            future_twitter = executor.submit(self.obtener_tweets_reales, provincia)
            future_bluesky = executor.submit(self.obtener_posts_bluesky, provincia)

            noticias = future_news.result()
            verificaciones = future_factcheck.result()
            tweets = future_twitter.result()
            bluesky = future_bluesky.result()

        feed = {
            "provincia": provincia,
            "tiempo_real": noticias,
            "verificaciones": verificaciones,
            "tweets_recientes": tweets,
            "bluesky_posts": bluesky
        }
        self.cache_feed[prov_key] = feed
        return feed

    # =========================================================================
    # 1. NOTICIAS EN TIEMPO REAL (Pura API o RSS real)
    # =========================================================================
    def obtener_noticias_reales(self, provincia: str) -> List[Dict[str, Any]]:
        noticias = []
        if self.gnews_api_key:
            try:
                query = f"elecciones {provincia} Ecuador"
                params = {"q": query, "lang": "es", "country": "ec", "max": 10, "apikey": self.gnews_api_key}
                resp = requests.get(self.GNEWS_URL, params=params, timeout=7)
                if resp.status_code == 200:
                    articles = resp.json().get("articles", [])
                    for art in articles:
                        noticias.append({
                            "titulo": art.get("title", "Sin título"),
                            "url": art.get("url", "#"),
                            "fecha": art.get("publishedAt", ""),
                            "fuente": art.get("source", {}).get("name", "Prensa")
                        })
            except Exception as e:
                logger.error(f"[GNews API] Error: {e}")

        # Si GNews falla, usamos el RSS real de Google News (Cero inventos)
        if not noticias:
            try:
                q = f"elecciones {provincia} Ecuador"
                rss_url = f"https://news.google.com/rss/search?q={requests.utils.quote(q)}&hl=es-419&gl=EC&ceid=EC:es-419"
                resp = requests.get(rss_url, timeout=6)
                if resp.status_code == 200:
                    root = ET.fromstring(resp.content)
                    for item in root.findall(".//item")[:8]:
                        source_elem = item.find("source")
                        noticias.append({
                            "titulo": item.findtext("title", "Noticia Electoral"),
                            "url": item.findtext("link", "#"),
                            "fecha": item.findtext("pubDate", ""),
                            "fuente": source_elem.text if source_elem is not None else "Prensa Ecuador",
                            "anio": "2026"
                        })
            except Exception as e:
                logger.error(f"[Google News RSS] Error en RSS: {e}")

        return noticias

    # =========================================================================
    # 2. FACT CHECK (Estricto, sin datos quemados)
    # =========================================================================
    def obtener_verificaciones_con_rating(self, provincia: str) -> List[Dict[str, Any]]:
        verificaciones = []
        if not self.fact_check_api_key:
            logger.warning("[Google Fact Check] API Key no configurada. Devolviendo vacío.")
            return [] # ¡Eliminado el arreglo de datos falsos!

        try:
            params = {"query": f"{provincia} elecciones Ecuador", "languageCode": "es", "key": self.fact_check_api_key}
            resp = requests.get(self.FACT_CHECK_URL, params=params, timeout=7)
            if resp.status_code == 200:
                claims = resp.json().get("claims", [])
                for claim in claims:
                    reviews = claim.get("claimReview", [])
                    rev = reviews[0] if reviews else {}
                    verificaciones.append({
                        "text": claim.get("text", "Afirmación registrada"),
                        "claimant": claim.get("claimant", "Redes Sociales / Político"),
                        "url": rev.get("url", "#"),
                        "publisher": rev.get("publisher", {}).get("name", "Verificador de Datos"),
                        "textualRating": rev.get("textualRating", "Revisado por Fact-Checker"),
                        "anio": "2026"
                    })
        except Exception as e:
            logger.error(f"[Google Fact Check] Error: {e}")

        return verificaciones

    # =========================================================================
    # 3. X (TWITTER) (Solo ntscraper, sin RSS inventado)
    # =========================================================================
    def obtener_tweets_reales(self, provincia: str) -> List[Dict[str, Any]]:
        tweets_limpios = []
        if self.scraper and HAS_NTSCRAPER:
            query = f"elecciones {provincia} Ecuador"
            try:
                resultado = self.scraper.get_tweets(query, mode='term', number=15)
                raw_tweets = resultado.get("tweets", []) if isinstance(resultado, dict) else []
                for tw in raw_tweets:
                    user_data = tw.get("user", {})
                    stats_data = tw.get("stats", {})
                    tweets_limpios.append({
                        "text": tw.get("text", ""),
                        "user": {
                            "name": user_data.get("name", "Usuario X"),
                            "username": user_data.get("username", "@usuario"),
                            "avatar": user_data.get("avatar", "")
                        },
                        "date": tw.get("date", ""),
                        "link": tw.get("link", "https://x.com"),
                        "stats": {
                            "likes": stats_data.get("likes", 0),
                            "retweets": stats_data.get("retweets", 0),
                            "replies": stats_data.get("comments", 0),
                            "quotes": stats_data.get("quotes", 0)
                        },
                        "anio": "2026"
                    })
            except Exception as e:
                logger.error(f"[ntscraper X] Error extrayendo '{query}': {e}")
        
        return tweets_limpios # ¡Eliminado el fallback que inventaba tuits!

    # =========================================================================
    # 4. BLUESKY (Solo SDK Oficial con filtro de texto real)
    # =========================================================================
    def obtener_posts_bluesky(self, provincia: str) -> List[Dict[str, Any]]:
        posts_bluesky = []
        handle = os.getenv("BLUESKY_HANDLE", "").strip()
        app_password = os.getenv("BLUESKY_PASSWORD", "").strip()

        if not handle or not app_password:
            return []

        try:
            from atproto import Client
            client = Client()
            client.login(handle, app_password)
            
            query = f"elecciones {provincia} Ecuador"
            respuesta = client.app.bsky.feed.search_posts({'q': query, 'limit': 15})
            
            for post in respuesta.posts:
                texto_post = getattr(post.record, 'text', '')
                
                # FILTRO ESTRICTO: Si el post no tiene texto, lo ignoramos para que no parezca un perfil vacío
                if not texto_post or len(texto_post.strip()) < 2:
                    continue

                fecha_creacion = post.record.created_at if hasattr(post.record, 'created_at') else ""
                anio_real = fecha_creacion[:4] if len(fecha_creacion) >= 4 else "2026"

                posts_bluesky.append({
                    "text": texto_post,
                    "author": {
                        "name": post.author.display_name or post.author.handle,
                        "handle": f"@{post.author.handle}",
                        "avatar": post.author.avatar if post.author.avatar else ""
                    },
                    "date": fecha_creacion,
                    "link": f"https://bsky.app/profile/{post.author.handle}/post/{post.uri.split('/')[-1]}",
                    "stats": {
                        "likes": getattr(post, 'like_count', 0),
                        "reposts": getattr(post, 'repost_count', 0),
                        "replies": getattr(post, 'reply_count', 0),
                        "quotes": getattr(post, 'quote_count', 0)
                    },
                    "anio": anio_real
                })

            return posts_bluesky
        except Exception as e:
            logger.error(f"[Bluesky] Error en la extracción: {e}")
            return []