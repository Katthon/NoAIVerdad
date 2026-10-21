"""Scheduled collection and persistence of news feeds in Firebase RTDB."""

import logging
import os
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import firebase_store

logger = logging.getLogger(__name__)

PROVINCES = [
    "Azuay", "Bolívar", "Cañar", "Carchi", "Chimborazo", "Cotopaxi", "El Oro",
    "Esmeraldas", "Galápagos", "Guayas", "Imbabura", "Loja", "Los Ríos",
    "Manabí", "Morona Santiago", "Napo", "Orellana", "Pastaza", "Pichincha",
    "Santa Elena", "Santo Domingo de los Tsáchilas", "Sucumbíos", "Tungurahua",
    "Zamora Chinchipe",
]

SECTION_KEYS = (
    "tiempo_real", "verificaciones", "tweets_recientes", "bluesky_posts", "meta_ads"
)
STOP_WORDS = {
    "para", "como", "donde", "cuando", "sobre", "entre", "desde", "hasta", "esta",
    "este", "estos", "estas", "todo", "toda", "todos", "todas", "tiene", "hacia",
    "tambien", "porque", "elecciones", "ecuador", "noticias", "segun", "tras",
}


def _key(name: str) -> str:
    normalized = unicodedata.normalize("NFD", name.lower())
    ascii_name = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9_]+", "_", ascii_name).strip("_")


def _collect_one(service, province: str) -> tuple[str, dict] | None:
    key = _key(province)
    try:
        feed = service.obtener_feed_completo(province)
        if not isinstance(feed, dict):
            logger.warning("El colector devolvió una respuesta inválida para %s.", province)
            return None

        previous = firebase_store.get(f"noticias/{key}")
        result = {"provincia": province}
        for section in SECTION_KEYS:
            fresh = feed.get(section)
            # Empty means the source returned no verifiable results; never resurrect
            # stale/demo records from the previous Firebase value.
            result[section] = fresh if isinstance(fresh, list) else []
        if isinstance(previous, dict):
            # Preserve both the former broad results and the previous local
            # snapshot when replacing it with a stricter electoral search.
            archive = previous.get("bluesky_posts_nacionales", [])
            old_posts = previous.get("bluesky_posts", [])
            archive = archive if isinstance(archive, list) else []
            old_posts = old_posts if isinstance(old_posts, list) else []
            merged = []
            seen = set()
            for item in archive + old_posts:
                identity = item.get("link") if isinstance(item, dict) else None
                if identity and identity not in seen:
                    seen.add(identity)
                    merged.append(item)
            result["bluesky_posts_nacionales"] = merged
        result["actualizado_en"] = datetime.now(timezone.utc).isoformat()
        if not firebase_store.set_value(f"noticias/{key}", result):
            return None
        logger.info(
            "Guardada %s en Firebase: %s noticias, %s verificaciones, %s redes.",
            province, len(result["tiempo_real"]), len(result["verificaciones"]),
            len(result["tweets_recientes"]) + len(result["bluesky_posts"]) + len(result["meta_ads"]),
        )
        return key, result
    except Exception:
        logger.exception("Error sincronizando datos de %s.", province)
        return None


def _build_dashboard(feeds: dict[str, dict]) -> dict:
    counts = {section: 0 for section in SECTION_KEYS}
    province_counts = []
    word_counts: dict[str, int] = {}
    for key, feed in feeds.items():
        province_total = 0
        for section in SECTION_KEYS:
            items = feed.get(section) if isinstance(feed.get(section), list) else []
            counts[section] += len(items)
            province_total += len(items)
            for item in items:
                if not isinstance(item, dict):
                    continue
                title = " ".join(str(item.get(field, "")) for field in (
                    "titulo", "text", "claim", "description", "texto"
                ))
                normalized = unicodedata.normalize("NFD", title.lower())
                normalized = "".join(c for c in normalized if unicodedata.category(c) != "Mn")
                for word in re.findall(r"[a-z]{4,}", normalized):
                    if word not in STOP_WORDS:
                        word_counts[word] = word_counts.get(word, 0) + 1
        if province_total:
            province_counts.append((feed.get("provincia", key), province_total))

    total = sum(counts.values())
    top = sorted(province_counts, key=lambda row: row[1], reverse=True)[:8]
    top_provinces = [
        {"provincia": name, "publicaciones": count,
         "porcentaje": round(count * 100 / total, 1) if total else 0}
        for name, count in top
    ]
    now = datetime.now(timezone.utc).isoformat()
    stats = {
        "provincia": "Ecuador (Todas)",
        "total_publicaciones": total,
        "distribucion_fuentes": {
            "prensa_tiempo_real": counts["tiempo_real"],
            "fact_checks": counts["verificaciones"],
            "redes_sociales_x": counts["tweets_recientes"],
            "bluesky_feed": counts["bluesky_posts"],
            "meta_ads": counts["meta_ads"],
        },
        "top_provincias_cobertura": top_provinces,
        "resumen_general": (
            f"El colector ha guardado {total} registros de fuentes externas en Firebase Realtime Database. "
            "Los resultados de fact-check no se interpretan automáticamente como verdaderos o falsos."
        ),
        "actualizado_en": now,
    }
    keywords = {
        "trending_keywords": [
            {"word": word, "count": count}
            for word, count in sorted(word_counts.items(), key=lambda row: row[1], reverse=True)[:12]
        ],
        "actualizado_en": now,
    }
    return stats, keywords


def refresh_all(service) -> dict:
    """Collect the 24 provinces on the server and persist them in Firebase."""
    if not firebase_store.initialize():
        return {"guardadas": 0, "total": len(PROVINCES), "firebase": False}

    reload_keys = getattr(service, "reload_api_keys", None)
    if callable(reload_keys):
        availability = reload_keys()
        logger.info("Credenciales de APIs recargadas desde Firebase: %s", availability)

    workers = max(1, min(int(os.getenv("NEWS_SYNC_CONCURRENCY", "3")), 5))
    feeds = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_collect_one, service, province) for province in PROVINCES]
        for future in as_completed(futures):
            result = future.result()
            if result:
                key, feed = result
                feeds[key] = feed

    # Include previously stored provinces if a provider was temporarily unavailable.
    for province in PROVINCES:
        key = _key(province)
        if key not in feeds:
            stored = firebase_store.get(f"noticias/{key}")
            if isinstance(stored, dict):
                feeds[key] = stored

    stats, keywords = _build_dashboard(feeds)
    firebase_store.set_value("dashboard/stats", stats)
    firebase_store.set_value("dashboard/keywords", keywords)
    return {"guardadas": len(feeds), "total": len(PROVINCES), "firebase": True}
