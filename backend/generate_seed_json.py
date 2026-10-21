"""Generate a blank Firebase import template without fabricated news records."""
import json
import re
import unicodedata
from datetime import datetime, timezone

PROVINCES = [
    "Azuay", "Bolívar", "Cañar", "Carchi", "Chimborazo", "Cotopaxi", "El Oro",
    "Esmeraldas", "Galápagos", "Guayas", "Imbabura", "Loja", "Los Ríos",
    "Manabí", "Morona Santiago", "Napo", "Orellana", "Pastaza", "Pichincha",
    "Santa Elena", "Santo Domingo de los Tsáchilas", "Sucumbíos", "Tungurahua",
    "Zamora Chinchipe",
]
SECTIONS = ("tiempo_real", "verificaciones", "tweets_recientes", "bluesky_posts", "meta_ads")


def _key(value):
    normalized = unicodedata.normalize("NFD", value.lower())
    ascii_name = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9_]+", "_", ascii_name).strip("_")


def generar_datos_completos(output_path="firebase_seed_data.json"):
    now = datetime.now(timezone.utc).isoformat()
    data = {
        "noticias": {
            _key(province): {
                "provincia": province,
                "actualizado_en": None,
                **{section: [] for section in SECTIONS},
            }
            for province in PROVINCES
        },
        "dashboard": {
            "stats": {
                "provincia": "Ecuador (Todas)",
                "total_publicaciones": 0,
                "distribucion_fuentes": {
                    "prensa_tiempo_real": 0, "fact_checks": 0, "redes_sociales_x": 0,
                    "bluesky_feed": 0, "meta_ads": 0,
                },
                "top_provincias_cobertura": [],
                "resumen_general": "Sin datos recolectados todavía.",
                "actualizado_en": None,
            },
            "keywords": {"trending_keywords": [], "actualizado_en": None},
        },
        "reportes_ciudadanos": {},
        "generado_en": now,
    }
    with open(output_path, "w", encoding="utf-8") as file:
        json.dump(data, file, indent=2, ensure_ascii=False)
    print(f"Plantilla vacía exportada: {output_path} ({len(PROVINCES)} provincias)")


if __name__ == "__main__":
    generar_datos_completos()
