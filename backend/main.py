import os
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Cargar variables de entorno desde .env (GOOGLE_FACT_CHECK_API_KEY y GNEWS_API_KEY)
load_dotenv()

from news_service import NewsFactCheckService

app = FastAPI(
    title="NoAIVerdad - API Backend (Fact-Checking y Noticias)",
    description="API para el monitoreo cívico de desinformación (Google Fact Check) y noticias en tiempo real (GNews) en Ecuador por provincia.",
    version="2.0.0"
)

# Configuración de CORS para permitir peticiones desde el frontend local y producción
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Instancia única del servicio integrador
news_service = NewsFactCheckService()


@app.get("/")
def read_root():
    """Ruta de verificación de estado (Healthcheck) y configuración de claves."""
    return {
        "sistema": "NoAIVerdad API v2.0",
        "estado": "Activo",
        "google_fact_check_configurado": bool(news_service.fact_check_api_key),
        "gnews_configurado": bool(news_service.gnews_api_key),
        "documentacion": "/docs"
    }


@app.get("/api/noticias")
def obtener_noticias_y_verificaciones_por_provincia(
    provincia: str = Query(
        ...,
        description="Nombre de la provincia de Ecuador a consultar (ej: Pichincha, Guayas, Azuay)",
        example="Pichincha"
    )
):
    """
    Endpoint principal: `GET /api/noticias?provincia={nombre_provincia}`.
    
    Ejecuta dos tareas de consulta:
    1. Tarea A (Noticias en Tiempo Real): Consulta a GNews API.
    2. Tarea B (Fact-Checking): Consulta a Google Fact Check Tools API.
    
    Estructura de respuesta devuelta:
    {
      "provincia": "Pichincha",
      "tiempo_real": [ { "titulo": "...", "url": "...", "fecha": "...", "fuente": "..." } ],
      "verificaciones": [ { "text": "...", "claimant": "...", "url": "...", "publisher": "...", "textualRating": "..." } ]
    }
    """
    if not provincia or not provincia.strip():
        raise HTTPException(status_code=400, detail="El parámetro 'provincia' es obligatorio y no puede estar vacío.")

    provincia_limpia = provincia.strip()

    try:
        # Obtener información combinada de noticias y verificaciones de forma segura
        resultado = news_service.obtener_informacion_provincia(provincia_limpia)
        return resultado

    except Exception as e:
        # Manejo preventivo de excepciones HTTP para evitar errores 500 no estructurados
        return {
            "provincia": provincia_limpia,
            "tiempo_real": [],
            "verificaciones": [],
            "error": True,
            "mensaje": f"No se pudieron obtener datos para la provincia {provincia_limpia}: {str(e)}"
        }


if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 8000))
    print(f"Iniciando servidor NoAIVerdad Backend v2.0 en http://{host}:{port}")
    uvicorn.run("main:app", host=host, port=port, reload=True)
