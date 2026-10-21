import os
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Cargar variables de entorno si existen (.env)
load_dotenv()

from meta_service import UnifiedFeedService
import firebase_store
from news_collector import refresh_all

_collector_task = None


async def _scheduled_collection_loop():
    interval = max(900, int(os.getenv("NEWS_REFRESH_INTERVAL_SECONDS", "21600")))
    print(f"[Firebase collector] Recolección de noticias cada {interval} segundos.", flush=True)
    while True:
        try:
            result = await asyncio.to_thread(refresh_all, unified_service)
            print(f"[Firebase collector] Ciclo terminado: {result}", flush=True)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Falló el ciclo del colector programado.")
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(_app):
    global _collector_task
    if firebase_store.initialize():
        _collector_task = asyncio.create_task(_scheduled_collection_loop())
    else:
        print("[Firebase collector] Sin credenciales Admin; la recolección programada está desactivada.", flush=True)
    try:
        yield
    finally:
        if _collector_task:
            _collector_task.cancel()
            try:
                await _collector_task
            except asyncio.CancelledError:
                pass
            _collector_task = None

# Inicializar aplicación FastAPI
app = FastAPI(
    title="NoAIVerdad - Backend Unificado (Noticias + Fact-Checking + X Scraper)",
    description="API en tiempo real para el monitoreo cívico de desinformación electoral en Ecuador por provincia, integrando GNews/RSS, Google Fact Check y X (Twitter).",
    version="4.1.0",
    lifespan=lifespan
)

# Configuración de CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Inicializar servicio unificado
unified_service = UnifiedFeedService()


@app.get("/")
def read_root():
    """Ruta raíz para verificación de estado del servidor."""
    return {
        "sistema": "NoAIVerdad API v4.0 Unificada",
        "estado": "Activo",
        "servicios": {
            "gnews_rss": True,
            "google_fact_check": bool(unified_service.fact_check_api_key),
            "x_api": bool(unified_service.x_api_enabled and unified_service.x_api_bearer_token),
            "x_ntscraper_fallback": False
        },
        "documentacion": "/docs"
    }


@app.get("/api/noticias")
def obtener_noticias_y_tweets_por_provincia(
    provincia: str = Query(
        ...,
        description="Nombre de la provincia de Ecuador a consultar (ej: Pichincha, Guayas, Azuay)"
    ),
    seccion: str = Query(
        None,
        description="Sección a consultar bajo demanda (noticias, verificaciones, tweets, bluesky)"
    )
):
    """
    Endpoint Rápido por Demanda: `GET /api/noticias?provincia={nombre_provincia}&seccion={seccion}`.
    
    Carga ultra rápida (< 1s) filtrando una única fuente por solicitud:
    - `seccion=noticias`: Prensa en tiempo real
    - `seccion=verificaciones`: Google Fact Check
    - `seccion=tweets`: Publicaciones en X / Twitter
    - `seccion=bluesky`: Publicaciones en vivo en Bluesky
    """
    if not provincia or not provincia.strip():
        raise HTTPException(status_code=400, detail="El parámetro 'provincia' es obligatorio.")

    provincia_limpia = provincia.strip()

    try:
        if seccion:
            feed = unified_service.obtener_feed_por_seccion(provincia_limpia, seccion)
        else:
            feed = unified_service.obtener_feed_completo(provincia_limpia)
        return feed

    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Error obteniendo feed para {provincia_limpia}: {str(e)}"
        ) from e


from typing import Optional, List, Dict, Any
from datetime import datetime

@app.get("/api/dashboard/stats")
def obtener_estadisticas_dashboard(provincia: Optional[str] = Query(None)):
    """Return live collector counts; no synthetic national totals or alert rates."""
    provincia_limpia = provincia.strip() if provincia else None
    if provincia_limpia and provincia_limpia.lower() not in {"todas", "ecuador"}:
        feed = unified_service.obtener_feed_completo(provincia_limpia)
        counts = {
            "prensa_tiempo_real": len(feed.get("tiempo_real", [])),
            "fact_checks": len(feed.get("verificaciones", [])),
            "redes_sociales_x": 0,
            "bluesky_feed": len(feed.get("bluesky_posts", [])),
            "meta_ads": len(feed.get("meta_ads", [])),
        }
        total = sum(counts.values())
        return {
            "provincia": provincia_limpia,
            "total_publicaciones": total,
            "distribucion_fuentes": counts,
            "top_provincias_cobertura": ([
                {"provincia": provincia_limpia, "publicaciones": total, "porcentaje": 100.0}
            ] if total else []),
            "resumen_general": (
                f"Se obtuvieron {total} registros de las fuentes consultadas para {provincia_limpia}. "
                "El recuento no determina la veracidad de las publicaciones."
            ),
            "actualizado_en": datetime.now().isoformat(),
        }

    stored = firebase_store.get("dashboard/stats")
    if isinstance(stored, dict):
        return stored
    return {
        "provincia": "Ecuador (Todas)",
        "total_publicaciones": 0,
        "distribucion_fuentes": {
            "prensa_tiempo_real": 0, "fact_checks": 0, "redes_sociales_x": 0,
            "bluesky_feed": 0, "meta_ads": 0,
        },
        "top_provincias_cobertura": [],
        "resumen_general": "Aún no hay estadísticas guardadas por el colector.",
        "actualizado_en": None,
    }


import re
from collections import Counter

STOP_WORDS = {
    "que", "las", "los", "por", "para", "con", "del", "una", "uno", "como", "mas", "más", 
    "sus", "este", "esta", "estos", "estas", "sobre", "entre", "hasta", "desde", "cada", 
    "todo", "toda", "todos", "todas", "pero", "sino", "donde", "cuando", "quien", "quienes", 
    "bien", "hace", "hacen", "hacer", "ser", "sido", "estar", "esta", "está", "están", 
    "hubo", "hay", "tiene", "tienen", "tenía", "dijo", "dicen", "decir", "ante", "tras", 
    "sin", "año", "años", "2026", "2027", "2025", "2024", "ecuador", "elecciones", "noticias", 
    "provincia", "tiempo", "real", "sobre", "para", "este", "esta", "para", "como", "esta"
}

def extraer_palabras_tendencia_reales() -> List[Dict[str, Any]]:
    """
    Extrae las palabras más frecuentes en tiempo real analizando el feed nacional de elecciones en Ecuador.
    """
    try:
        noticias = unified_service.obtener_noticias_reales("Ecuador")
        textos = " ".join([n.get("titulo", "") for n in noticias])

        tokens = re.findall(r'\b[a-zA-ZáéíóúñÁÉÍÓÚÑ]{3,}\b', textos)
        palabras_filtradas = [
            t.capitalize() for t in tokens 
            if t.lower() not in STOP_WORDS and len(t) > 3
        ]

        conteo = Counter(palabras_filtradas).most_common(8)

        if not conteo:
            return []

        res = []
        for word, count in conteo:
            cat = "Término Destacado"
            w_up = word.upper()
            if w_up in ["CNE", "TCE"]:
                cat = "Institución Electoral"
            elif w_up in ["NOBOA", "LUISA", "LASSO", "CORREA", "TOPIC"]:
                cat = "Candidato / Figura Política"
            elif w_up in ["SEGURIDAD", "EMPLEO", "ECONOMÍA", "SALUD"]:
                cat = "Tema Principal"

            res.append({"word": word, "count": count, "category": cat})

        return res

    except Exception as e:
        print(f"Error generando tendencias reales: {e}")
        return []


@app.get("/api/dashboard/keywords")
def obtener_analisis_palabras_clave(q: Optional[str] = Query(None), provincia: Optional[str] = Query(None)):
    """
    Endpoint para el Buscador de Palabras Clave y Tendencias Electorales.
    Extrae palabras frecuentes reales y busca artículos específicos para cualquier término en tiempo real.
    """
    trending_list = extraer_palabras_tendencia_reales()

    word_query = q.strip() if (q and isinstance(q, str)) else None

    if not word_query:
        return {
            "trending_keywords": trending_list,
            "analisis": None
        }

    word_lower = word_query.lower()
    
    # Consultar noticias específicas en vivo para el término buscado
    noticias_especificas = unified_service.obtener_noticias_reales(f"{word_query} Ecuador")
    facts_especificos = unified_service.obtener_verificaciones_con_rating(f"{word_query}")

    coincidencias = []
    c_prensa = 0
    c_fact = 0
    c_x = 0
    c_bsky = 0
    c_meta = 0

    # Escanear noticias de prensa devueltas para la búsqueda específica
    for n in noticias_especificas:
        txt = (str(n.get("titulo", "")) + " " + str(n.get("fuente", ""))).lower()
        if word_lower in txt:
            c_prensa += 1
            coincidencias.append({
                "titulo": n.get("titulo"),
                "fuente": "Prensa (" + n.get("fuente", "Prensa") + ")",
                "link": n.get("url")
            })

    # Escanear verificaciones de Fact Check para la búsqueda específica
    for f in facts_especificos:
        claim_text = str(f.get("text", ""))
        if word_lower not in claim_text.lower():
            continue
        c_fact += 1
        coincidencias.append({
            "titulo": "Fact-Check: " + claim_text,
            "fuente": f.get("publisher", "Google FactCheck"),
            "link": f.get("url")
        })

    # No contar los resultados devueltos por una API si no contienen el término buscado.
    if not coincidencias:
        return {
            "trending_keywords": trending_list,
            "analisis": {
                "palabra": word_query,
                "menciones_totales": 0,
                "categoria": "Sin Menciones Detectadas",
                "distribucion": {"prensa": 0, "fact_check": 0, "x_twitter": 0, "bluesky": 0, "meta": 0},
                "resumen_analisis": f"No se encontraron menciones en tiempo real para el término '<strong>{word_query}</strong>' en la cobertura informativa.",
                "titulares_relacionados": []
            }
        }

    total_menciones = len(coincidencias)
    found_trending = next((item for item in trending_list if item["word"].lower() == word_lower), None)
    cat = found_trending["category"] if found_trending else "Término Electoral"

    titulares_muestra = [c["titulo"] for c in coincidencias[:5]]

    return {
        "trending_keywords": trending_list,
        "analisis": {
            "palabra": word_query,
            "menciones_totales": total_menciones,
            "categoria": cat,
            "distribucion": {
                "prensa": c_prensa,
                "fact_check": c_fact,
                "x_twitter": c_x,
                "bluesky": c_bsky,
                "meta": c_meta
            },
            "resumen_analisis": (
                f"El término <strong>'{word_query}'</strong> registra <span class='summary-highlight'>{total_menciones} noticia(s) y publicación(es) en tiempo real</span> "
                f"en la cobertura actual ({c_prensa} en Prensa Nacional, {c_fact} en Fact-Checking)."
            ),
            "titulares_relacionados": titulares_muestra
        }
    }


if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 8000))
    print(f"Iniciando servidor unificado NoAIVerdad Backend v4.0 en http://{host}:{port}")
    uvicorn.run("main:app", host=host, port=port, reload=True)

