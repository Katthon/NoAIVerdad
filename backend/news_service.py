import os
import requests
import logging
import asyncio
from typing import List, Dict, Any

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class NewsFactCheckService:
    """
    Servicio encargado de la integración concurrente sin datos quemados con:
    1. GNews API (Noticias en tiempo real)
    2. Google Fact Check Tools API (Verificaciones de datos y desinformación)
    """

    GNEWS_URL = "https://gnews.io/api/v4/search"
    FACT_CHECK_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search"

    def __init__(self):
        self.gnews_api_key = os.getenv("GNEWS_API_KEY", "").strip()
        self.fact_check_api_key = os.getenv("GOOGLE_FACT_CHECK_API_KEY", "").strip()

    async def obtener_informacion_provincia(self, provincia: str) -> Dict[str, Any]:
        """
        Ejecuta las consultas a GNews y Google Fact Check de manera asíncrona.
        """
        # Ejecutar peticiones concurrentes
        gnews_task = asyncio.create_task(self.consultar_gnews(provincia))
        factcheck_task = asyncio.create_task(self.consultar_google_fact_check(provincia))

        # Esperar a que ambas tareas terminen
        noticias_tiempo_real, verificaciones_factcheck = await asyncio.gather(gnews_task, factcheck_task)

        return {
            "provincia": provincia,
            "tiempo_real": noticias_tiempo_real,
            "verificaciones": verificaciones_factcheck
        }

    async def consultar_gnews(self, provincia: str) -> List[Dict[str, Any]]:
        """TAREA A: Consulta la API de GNews. Devuelve lista vacía si falla."""
        if not self.gnews_api_key:
            logger.error("Error: GNEWS_API_KEY no configurada.")
            return []

        # Buscamos primero con un término específico
        query = f"elecciones {provincia} Ecuador"
        params = {
            "q": query,
            "lang": "es",
            "country": "ec",
            "max": 10,
            "apikey": self.gnews_api_key
        }

        try:
            logger.info(f"Consultando GNews para: '{query}'...")
            response = requests.get(self.GNEWS_URL, params=params, timeout=8)
            
            if response.status_code == 200:
                return self._mapear_resultados_gnews(response.json())
            
            logger.warning(f"GNews API falló con código {response.status_code}: {response.text}")
            return []
            
        except Exception as e:
            logger.error(f"Excepción al consultar GNews: {e}")
            return []

    def _mapear_resultados_gnews(self, data: dict) -> List[Dict[str, Any]]:
        """Mapea la respuesta JSON cruda de GNews a la estructura deseada."""
        articles = data.get("articles", [])
        resultados = []
        for art in articles:
            resultados.append({
                "titulo": art.get("title", "Sin título"),
                "url": art.get("url", "#"),
                "fecha": art.get("publishedAt", ""),
                "fuente": art.get("source", {}).get("name", "Fuente no especificada")
            })
        return resultados

    async def consultar_google_fact_check(self, provincia: str) -> List[Dict[str, Any]]:
        """TAREA B: Consulta Google Fact Check. Devuelve lista vacía si falla."""
        if not self.fact_check_api_key:
            logger.error("Error: GOOGLE_FACT_CHECK_API_KEY no configurada.")
            return []

        query = f"{provincia} elecciones Ecuador"
        params = {
            "query": query,
            "languageCode": "es",
            "key": self.fact_check_api_key
        }

        try:
            logger.info(f"Consultando Google Fact Check para: '{query}'...")
            response = requests.get(self.FACT_CHECK_URL, params=params, timeout=8)
            
            if response.status_code == 200:
                data = response.json()
                claims = data.get("claims", [])
                
                # Si la búsqueda específica no devuelve nada, intentamos algo general de Ecuador
                if not claims:
                    logger.info(f"Fact Check vacía para '{query}'. Probando búsqueda general de Ecuador...")
                    params["query"] = "Ecuador elecciones"
                    response_general = requests.get(self.FACT_CHECK_URL, params=params, timeout=8)
                    if response_general.status_code == 200:
                         claims = response_general.json().get("claims", [])
                
                return self._mapear_resultados_fact_check(claims)

            logger.warning(f"Google Fact Check API falló con código {response.status_code}: {response.text}")
            return []

        except Exception as e:
            logger.error(f"Excepción al consultar Google Fact Check: {e}")
            return []

    def _mapear_resultados_fact_check(self, claims: list) -> List[Dict[str, Any]]:
         """Mapea la respuesta JSON cruda de Fact Check a la estructura deseada."""
         verificaciones = []
         for claim in claims:
             texto_afirmacion = claim.get("text", "Afirmación sin texto")
             quien_lo_dijo = claim.get("claimant", "No especificado")
             reviews = claim.get("claimReview", [])

             if reviews:
                 primera_revision = reviews[0]
                 url_revision = primera_revision.get("url", "#")
                 veredicto = primera_revision.get("textualRating", "Sin veredicto")
                 editor = primera_revision.get("publisher", {}).get("name", "Verificador de Datos")
             else:
                 url_revision = "#"
                 veredicto = "No verificado"
                 editor = "Fact Checker"

             verificaciones.append({
                 "text": texto_afirmacion,
                 "claimant": quien_lo_dijo,
                 "url": url_revision,
                 "publisher": editor,
                 "textualRating": veredicto
             })
         return verificaciones