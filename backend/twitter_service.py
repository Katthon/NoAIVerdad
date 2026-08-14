import logging
import time
from typing import List, Dict, Any, Optional

# Configuración de logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Intento de importación de ntscraper con fallback preventivo
try:
    from ntscraper import Nitter
    HAS_NTSCRAPER = True
except ImportError:
    HAS_NTSCRAPER = False
    logger.warning("Librería 'ntscraper' no detectada. Para scraping real ejecute: pip install ntscraper")


class TwitterScraperService:
    """
    Servicio de extracción no oficial de X (Twitter) utilizando ntscraper.
    VERSIÓN CORREGIDA: Sin datos quemados.
    """

    def __init__(self, log_level: int = 1):
        self.scraper = None
        if HAS_NTSCRAPER:
            try:
                self.scraper = Nitter(log_level=log_level)
                logger.info("Instancia de Nitter (ntscraper) inicializada correctamente.")
            except Exception as e:
                logger.error(f"Error al inicializar Nitter: {e}")

    def obtener_tweets_por_provincia(self, provincia: str, limite: int = 15) -> Dict[str, Any]:
        query = f"elecciones {provincia} Ecuador"
        tweets_limpios: List[Dict[str, Any]] = []

        # 1. Si no está instalada la librería, avisamos de inmediato
        if not HAS_NTSCRAPER or not self.scraper:
            return {
                "provincia": provincia,
                "origen": "X (Twitter)",
                "tweets_recientes": [],
                "advertencia": "ntscraper no está instalado o inicializado."
            }

        # 2. Intento real de extracción
        try:
            logger.info(f"Buscando en X (vía Nitter) término: '{query}'...")
            
            resultado = self.scraper.get_tweets(query, mode='term', number=limite)
            raw_tweets = resultado.get("tweets", []) if isinstance(resultado, dict) else []

            for tw in raw_tweets:
                user_data = tw.get("user", {})
                stats_data = tw.get("stats", {})

                tweets_limpios.append({
                    "text": tw.get("text", "Sin contenido"),
                    "user": {
                        "name": user_data.get("name", "Usuario de X"),
                        "username": user_data.get("username", "@usuario"),
                        "avatar": user_data.get("avatar", "")
                    },
                    "date": tw.get("date", "Reciente"),
                    "link": tw.get("link", "https://x.com"),
                    "stats": {
                        "likes": stats_data.get("likes", 0),
                        "retweets": stats_data.get("retweets", 0)
                    }
                })

            # 3. Devolvemos LA VERDAD (incluso si la lista está vacía)
            return {
                "provincia": provincia,
                "origen": "X (Twitter) vía Nitter",
                "tweets_recientes": tweets_limpios,
                "advertencia": None if tweets_limpios else "No se encontraron noticias en X para esta provincia."
            }

        except Exception as e:
            # 4. Si Nitter falla, capturamos el error real
            logger.error(f"Error real de extracción en ntscraper: {e}")
            return {
                "provincia": provincia,
                "origen": "X (Twitter) vía Nitter",
                "tweets_recientes": [],
                "advertencia": f"Falla de conexión con X: {str(e)}"
            }