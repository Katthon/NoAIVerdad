import os
import requests
import unicodedata
import logging
from typing import List, Dict, Any, Optional

# Configuración de logging para diagnóstico
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def normalizar_texto(texto: str) -> str:
    """
    Normaliza una cadena de texto eliminando acentos, tildes y caracteres especiales,
    y convirtiendo todo a minúsculas para comparaciones flexibles.
    Ejemplo: 'Bolívar' -> 'bolivar', 'Manabí' -> 'manabi'.
    """
    if not texto:
        return ""
    texto_normalizado = unicodedata.normalize('NFKD', texto)
    texto_sin_acentos = "".join([c for c in texto_normalizado if not unicodedata.combining(c)])
    return texto_sin_acentos.lower().strip()

class MetaAdLibraryService:
    """
    Servicio para interactuar con la API Meta Ad Library (Graph API)
    y filtrar anuncios de campaña electoral según la provincia de alcance.
    """

    GRAPH_API_URL = "https://graph.facebook.com/v19.0/ads_archive"

    def __init__(self):
        self.access_token = os.getenv("META_ACCESS_TOKEN", "").strip()
        self.app_id = os.getenv("META_APP_ID", "1035383682616354")

    def esta_configurado(self) -> bool:
        """Verifica si se ha configurado un Access Token válido de Meta."""
        return bool(self.access_token and self.access_token != "TU_META_ACCESS_TOKEN_AQUI")

    def obtener_anuncios_por_provincia(
        self, provincia: str, umbral_porcentaje: float = 0.05
    ) -> Dict[str, Any]:
        """
        Consulta la Meta Ad Library API para Ecuador y filtra los resultados 
        donde 'delivery_by_region' indique entregas significativas en la provincia especificada.

        :param provincia: Nombre de la provincia a consultar (ej: 'Pichincha', 'Guayas', 'Azuay')
        :param umbral_porcentaje: Porcentaje mínimo de impresiones en la región (por defecto 5%)
        :return: Diccionario con la lista de anuncios procesados y metadatos
        """
        provincia_norm = normalizar_texto(provincia)

        # Si no hay token de Meta configurado, se devuelven datos de prueba/demostración estructurados
        if not self.esta_configurado():
            logger.warning(
                "META_ACCESS_TOKEN no configurado en .env. Devolviendo anuncios de demostración."
            )
            return {
                "provincia": provincia,
                "total_resultados": 0,
                "es_demostracion": True,
                "mensaje": "Clave META_ACCESS_TOKEN no configurada en .env. Se muestran datos sintéticos de prueba.",
                "anuncios": self._generar_datos_demostracion(provincia)
            }

        # Parámetros oficiales según documentación de Meta Ad Library API
        params = {
            "access_token": self.access_token,
            "ad_active_status": "ALL",
            "search_terms": "elecciones OR candidato OR propaganda OR voto",
            "ad_reached_countries": "['EC']",  # Formato array para Ecuador
            "fields": (
                "id,ad_creation_time,ad_creative_bodies,ad_creative_link_captions,"
                "ad_creative_link_titles,ad_delivery_start_time,ad_delivery_stop_time,"
                "page_id,page_name,currency,spend,impressions,delivery_by_region"
            ),
            "limit": 50
        }

        try:
            logger.info(f"Consultando Meta Ad Library API para Ecuador (Provincia: {provincia})...")
            response = requests.get(self.GRAPH_API_URL, params=params, timeout=10)
            
            if response.status_code != 200:
                error_data = response.json().get("error", {})
                error_msg = error_data.get("message", "Error al comunicarse con Meta Ad Library API")
                logger.error(f"Error de Meta API ({response.status_code}): {error_msg}")
                return {
                    "provincia": provincia,
                    "error": True,
                    "mensaje": f"Error de Meta API: {error_msg}",
                    "anuncios": self._generar_datos_demostracion(provincia)
                }

            datos = response.json().get("data", [])
            anuncios_filtrados = []

            for anuncio in datos:
                delivery_regions = anuncio.get("delivery_by_region", [])
                match_provincia = False
                porcentaje_region = 0.0

                # Lógica de filtrado geográfico en Python por delivery_by_region
                for region in delivery_regions:
                    nombre_region = normalizar_texto(region.get("region", ""))
                    try:
                        pct = float(region.get("percentage", 0.0))
                    except (ValueError, TypeError):
                        pct = 0.0

                    # Coincidencia si el nombre normalizado coincide o contiene la provincia
                    if provincia_norm in nombre_region or nombre_region in provincia_norm:
                        if pct >= umbral_porcentaje:
                            match_provincia = True
                            porcentaje_region = pct
                            break

                if match_provincia:
                    cuerpos = anuncio.get("ad_creative_bodies", [])
                    cuerpo_texto = cuerpos[0] if cuerpos else "Sin texto descriptivo"
                    
                    anuncios_filtrados.append({
                        "id": anuncio.get("id"),
                        "page_name": anuncio.get("page_name", "Página desconocida"),
                        "page_id": anuncio.get("page_id"),
                        "contenido": cuerpo_texto,
                        "titulo": (anuncio.get("ad_creative_link_titles") or ["Anuncio Político"])[0],
                        "fecha_inicio": anuncio.get("ad_delivery_start_time"),
                        "fecha_fin": anuncio.get("ad_delivery_stop_time"),
                        "porcentaje_alcance_provincia": round(porcentaje_region * 100, 2),
                        "gasto_estimado": anuncio.get("spend", {}),
                        "impresiones": anuncio.get("impressions", {}),
                        "url_ad_library": f"https://www.facebook.com/ads/library/?id={anuncio.get('id')}"
                    })

            return {
                "provincia": provincia,
                "total_resultados": len(anuncios_filtrados),
                "es_demostracion": False,
                "anuncios": anuncios_filtrados
            }

        except Exception as e:
            logger.exception("Excepción durante la consulta a Meta API")
            return {
                "provincia": provincia,
                "error": True,
                "mensaje": f"Excepción interna: {str(e)}",
                "anuncios": self._generar_datos_demostracion(provincia)
            }

    def _generar_datos_demostracion(self, provincia: str) -> List[Dict[str, Any]]:
        """
        Genera datos sintéticos realistas para pruebas locales cuando
        no se dispone aún del Access Token de Meta Ad Library.
        """
        return [
            {
                "id": "10192837465",
                "page_name": f"Alianza Cívica {provincia}",
                "page_id": "88776655",
                "contenido": f"¡Atención ciudadanos de {provincia}! Descubre las propuestas sobre transparencia y empleo directo para nuestra región en las próximas elecciones.",
                "titulo": f"Plan Regional de Desarrollo para {provincia}",
                "fecha_inicio": "2026-08-01T08:00:00Z",
                "fecha_fin": None,
                "porcentaje_alcance_provincia": 78.5,
                "gasto_estimado": {"lower_bound": "100", "upper_bound": "499", "currency": "USD"},
                "impresiones": {"lower_bound": "10000", "upper_bound": "50000"},
                "url_ad_library": "https://www.facebook.com/ads/library/?id=10192837465"
            },
            {
                "id": "20987654321",
                "page_name": "Observatorio Electoral Ecuador",
                "page_id": "11223344",
                "contenido": f"Analizamos la veracidad de los discursos de campaña emitidos en la provincia de {provincia}. Conoce los hechos verificados por NoAIVerdad.",
                "titulo": "Fact-checking de propuestas de campaña",
                "fecha_inicio": "2026-08-05T14:30:00Z",
                "fecha_fin": None,
                "porcentaje_alcance_provincia": 64.2,
                "gasto_estimado": {"lower_bound": "50", "upper_bound": "199", "currency": "USD"},
                "impresiones": {"lower_bound": "5000", "upper_bound": "20000"},
                "url_ad_library": "https://www.facebook.com/ads/library/?id=20987654321"
            },
            {
                "id": "30495867123",
                "page_name": f"Frente por el Futuro de {provincia}",
                "page_id": "55443322",
                "contenido": f"Inversión prioritaria en infraestructura víal y conectividad para las familias de {provincia}. ¡Tu voto transforma la provincia!",
                "titulo": "Propuesta Vial y Desarrollo Local",
                "fecha_inicio": "2026-08-10T11:15:00Z",
                "fecha_fin": None,
                "porcentaje_alcance_provincia": 89.1,
                "gasto_estimado": {"lower_bound": "500", "upper_bound": "999", "currency": "USD"},
                "impresiones": {"lower_bound": "50000", "upper_bound": "100000"},
                "url_ad_library": "https://www.facebook.com/ads/library/?id=30495867123"
            }
        ]
