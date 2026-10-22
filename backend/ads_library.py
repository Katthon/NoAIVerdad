"""
Cliente de la Biblioteca de Anuncios de Meta (Graph API `ads_archive`).

Trae anuncios de tipo POLITICAL_AND_ISSUE_ADS que alcanzaron Ecuador y los
normaliza. Los datos son reales: si no hay token o la API falla, devuelve una
lista vacía junto con un estado explicativo; nunca inventa anuncios.

Notas de diseño:
- La API exige un término de búsqueda, así que se consultan a nivel nacional
  unos pocos términos electorales (configurables) y se cachea el resultado. El
  filtro por provincia se hace después con `delivery_by_region`, que indica el
  porcentaje del alcance de cada anuncio por región.
- `spend` e `impressions` llegan como rangos, no como cifras exactas.
- `ad_snapshot_url` NO se solicita ni se reenvía: Meta incrusta el access token
  en esa URL. El enlace público se arma con el id del anuncio.
- Los mensajes de error se limpian para que el token nunca aparezca en logs ni
  en las respuestas de la API.
"""
import json
import logging
import os
import tempfile
import re
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import requests
import firebase_store

logger = logging.getLogger(__name__)

GRAPH_URL = "https://graph.facebook.com/{version}/ads_archive"
LIBRARY_URL = "https://www.facebook.com/ads/library/?id={ad_id}"

CORE_FIELDS = [
    "id", "page_id", "page_name", "bylines",
    "ad_creation_time", "ad_delivery_start_time", "ad_delivery_stop_time",
    "ad_creative_bodies", "ad_creative_link_titles",
    "currency", "spend", "impressions", "publisher_platforms",
]
# Solo disponibles para POLITICAL_AND_ISSUE_ADS.
POLITICAL_FIELDS = ["delivery_by_region", "demographic_distribution", "estimated_audience_size"]

DEFAULT_TERMS = "elecciones,candidato,alcalde,prefecto,concejal,CNE,seccionales,voto"

# Texto que Meta pone en lugar de un anuncio retirado (inglés y español), ya normalizado.
_PLACEHOLDER_RETIRADO = re.compile(
    r"(we later disabled|advertising standards|was removed because|normas publicitarias|"
    r"estandares de publicidad|cuenta o pagina que inhabilitamos)"
)

_TOKEN_RE = re.compile(r"(access_token=)[^&\s'\")]+", re.IGNORECASE)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _norm(texto: Any) -> str:
    """Minúsculas, sin tildes ni signos, sin la palabra 'provincia/province'."""
    s = unicodedata.normalize("NFKD", str(texto or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\b(provincia|province)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# Las 24 provincias de Ecuador (sin tildes, como las normaliza _norm). Meta también reporta regiones de otros países.
_PROVINCIAS_EC = {
    "azuay": "Azuay", "bolivar": "Bolívar", "canar": "Cañar", "carchi": "Carchi", "chimborazo": "Chimborazo",
    "cotopaxi": "Cotopaxi", "el oro": "El Oro", "esmeraldas": "Esmeraldas", "galapagos": "Galápagos",
    "guayas": "Guayas", "imbabura": "Imbabura", "loja": "Loja", "los rios": "Los Ríos", "manabi": "Manabí",
    "morona santiago": "Morona Santiago", "napo": "Napo", "orellana": "Orellana", "pastaza": "Pastaza",
    "pichincha": "Pichincha", "santa elena": "Santa Elena",
    "santo domingo de los tsachilas": "Santo Domingo de los Tsáchilas", "sucumbios": "Sucumbíos",
    "tungurahua": "Tungurahua", "zamora chinchipe": "Zamora Chinchipe",
}


def _nombre_region(region: str) -> str:
    """Nombre de región de Meta -> nombre canónico de provincia (une 'Bolivar'/'Bolívar', 'Morona-Santiago', etc.)."""
    limpio = re.sub(r"\s+Province$", "", str(region or "")).strip()
    return _PROVINCIAS_EC.get(_norm(limpio), limpio)


_SUFIJOS_LEGALES = {"s", "a", "sa", "sas", "cia", "ltda", "ltd", "c", "l"}


def _norm_entidad(texto: Any) -> str:
    """Nombre de página/financiador sin tildes, mayúsculas ni sufijos legales (S.A.S, Cía. Ltda.)."""
    return " ".join(t for t in _norm(texto).split() if t not in _SUFIJOS_LEGALES)


def _misma_entidad(a: Any, b: Any) -> bool:
    na, nb = _norm_entidad(a), _norm_entidad(b)
    if not na or not nb:
        return False
    return na == nb or (len(na) >= 4 and na in nb) or (len(nb) >= 4 and nb in na)


def _to_int(valor: Any) -> Optional[int]:
    try:
        return int(valor)
    except (TypeError, ValueError):
        return None


def _to_float(valor: Any) -> float:
    try:
        return float(valor)
    except (TypeError, ValueError):
        return 0.0


def _medio(rango: Optional[Dict[str, Optional[int]]]) -> float:
    """Punto medio de un rango {min, max} (si falta un extremo, usa el otro)."""
    if not rango:
        return 0.0
    lo, hi = rango.get("min"), rango.get("max")
    if lo is None and hi is None:
        return 0.0
    if hi is None:
        return float(lo)
    if lo is None:
        return float(hi)
    return (lo + hi) / 2.0


def _rango(obj: Any) -> Optional[Dict[str, Optional[int]]]:
    """{'lower_bound': '100', 'upper_bound': '499'} -> {'min': 100, 'max': 499}."""
    if not isinstance(obj, dict):
        return None
    return {"min": _to_int(obj.get("lower_bound")), "max": _to_int(obj.get("upper_bound"))}


class AdLibraryClient:
    def __init__(self):
        self.token = ""
        self.version = os.getenv("META_GRAPH_VERSION", "v23.0").strip() or "v23.0"
        self.country = os.getenv("AD_LIBRARY_COUNTRY", "EC").strip().upper() or "EC"
        self.terms = [t.strip() for t in os.getenv("AD_LIBRARY_TERMS", DEFAULT_TERMS).split(",") if t.strip()]
        self.days = _env_int("AD_LIBRARY_DAYS", 120)
        self.pages_per_term = max(1, _env_int("AD_LIBRARY_PAGES", 2))
        self.cache_ttl = _env_float("AD_LIBRARY_CACHE_MIN", 30.0) * 60
        self.min_region_pct = _env_float("AD_LIBRARY_MIN_REGION_PCT", 0.05)
        self.url = GRAPH_URL.format(version=self.version)
        carpeta = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
        self.snapshot_path = os.getenv("AD_LIBRARY_SNAPSHOT", os.path.join(carpeta, "ads_snapshot.json"))

        self._cache: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()
        self.reload_token()

    def reload_token(self) -> bool:
        """Load the server-side Meta token from Firebase RTDB; never expose it to callers."""
        try:
            keys = firebase_store.get_api_keys()
        except Exception:
            logger.warning("[AdLibrary] No se pudo consultar la configuración privada de Firebase.")
            keys = {}
        token = (keys.get("META_AD_LIBRARY_TOKEN") or keys.get("FB_META_ACCESS_TOKEN") or
                 os.getenv("META_AD_LIBRARY_TOKEN", "")).strip()
        changed = token != self.token
        if changed:
            with self._lock:
                self.token = token
                self._cache = None
        return bool(self.token)

    @property
    def configurado(self) -> bool:
        if not self.token:
            self.reload_token()
        return bool(self.token)

    # ------------------------------------------------------------------
    # Acceso a la API
    # ------------------------------------------------------------------
    def _scrub(self, texto: Any) -> str:
        limpio = _TOKEN_RE.sub(r"\1***", str(texto))
        if self.token:
            limpio = limpio.replace(self.token, "***")
        return limpio[:300]

    def _get(self, params: Dict[str, Any]) -> Tuple[Optional[int], Optional[Dict[str, Any]], str]:
        """Devuelve (status_http, cuerpo_json, error). `error` queda vacío si todo salió bien."""
        if not self.token:
            self.reload_token()
        if not self.token:
            return None, None, "Falta el token de acceso de Meta en Firebase (/config/api_keys)."
        try:
            r = requests.get(self.url, params={**params, "access_token": self.token}, timeout=12)
        except requests.RequestException as e:
            return None, None, self._scrub(f"Error de red: {e}")

        try:
            cuerpo = r.json()
        except ValueError:
            cuerpo = None

        if r.status_code != 200:
            err = cuerpo.get("error", {}) if isinstance(cuerpo, dict) else {}
            detalle = err.get("message") or r.text[:200]
            if err.get("code") == 190:
                return r.status_code, None, "El token de acceso a la API de Meta venció o no es válido (código 190)."
            return r.status_code, None, self._scrub(f"HTTP {r.status_code} (código {err.get('code')}): {detalle}")
        if not isinstance(cuerpo, dict):
            return r.status_code, None, "Respuesta no válida de la API."
        return r.status_code, cuerpo, ""

    def _fetch_term(self, term: str, limit: int = 50, pages: Optional[int] = None,
                    fields: Optional[List[str]] = None) -> Tuple[List[Dict[str, Any]], str]:
        """Descarga los anuncios crudos para un término, siguiendo la paginación por cursor."""
        campos = fields or (CORE_FIELDS + POLITICAL_FIELDS)
        desde = (date.today() - timedelta(days=self.days)).isoformat()
        crudos: List[Dict[str, Any]] = []
        after = None

        for _ in range(pages or self.pages_per_term):
            params = {
                "search_terms": term,
                "ad_type": "POLITICAL_AND_ISSUE_ADS",
                "ad_reached_countries": json.dumps([self.country]),
                "ad_active_status": "ALL",
                "ad_delivery_date_min": desde,
                "fields": ",".join(campos),
                "limit": limit,
            }
            if after:
                params["after"] = after

            status, cuerpo, err = self._get(params)
            if err:
                # Si esta versión de la API rechaza un campo, reintentar solo con los básicos.
                if status == 400 and not crudos and fields is None and "field" in err.lower():
                    logger.warning("[AdLibrary] Campo rechazado por la API; reintentando con campos básicos.")
                    return self._fetch_term(term, limit, pages, CORE_FIELDS)
                return crudos, err

            crudos.extend(cuerpo.get("data") or [])
            paging = cuerpo.get("paging") or {}
            after = (paging.get("cursors") or {}).get("after")
            if not paging.get("next") or not after:
                break

        return crudos, ""

    # ------------------------------------------------------------------
    # Normalización
    # ------------------------------------------------------------------
    def _normalizar(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        ad_id = str(raw.get("id") or "")
        cuerpos = raw.get("ad_creative_bodies") or []
        titulos = raw.get("ad_creative_link_titles") or []
        texto = (cuerpos[0] if cuerpos else "") or (titulos[0] if titulos else "")

        inicio = raw.get("ad_delivery_start_time") or raw.get("ad_creation_time") or ""
        fin = raw.get("ad_delivery_stop_time") or ""

        regiones = [
            {"region": str(r.get("region") or ""), "porcentaje": _to_float(r.get("percentage"))}
            for r in (raw.get("delivery_by_region") or []) if isinstance(r, dict)
        ]
        total = sum(r["porcentaje"] for r in regiones)
        if total > 1.5:  # llegó como 0-100 en vez de 0-1
            for r in regiones:
                r["porcentaje"] /= 100.0
        regiones.sort(key=lambda r: r["porcentaje"], reverse=True)

        return {
            "id": ad_id,
            "text": str(texto).strip(),
            "page_name": raw.get("page_name") or "Página sin nombre",
            "page_id": raw.get("page_id"),
            "financiador": raw.get("bylines") or "",
            "date": inicio,
            "fecha_fin": fin,
            "activo": not fin,
            "anio": inicio[:4] if re.match(r"^\d{4}", inicio) else "",
            "link": LIBRARY_URL.format(ad_id=ad_id) if ad_id.isdigit() else "https://www.facebook.com/ads/library/",
            "moneda": raw.get("currency") or "",
            "gasto": _rango(raw.get("spend")),
            "impresiones": _rango(raw.get("impressions")),
            "audiencia_estimada": _rango(raw.get("estimated_audience_size")),
            "plataformas": raw.get("publisher_platforms") or [],
            "regiones": regiones,
            "demografia": raw.get("demographic_distribution") or [],
            "fuente": "meta_ad_library",
        }

    # ------------------------------------------------------------------
    # API pública del servicio
    # ------------------------------------------------------------------
    # ------------------------------------------------------------------
    # Copia en disco del último resultado completo (resiliencia ante token vencido o caída de la API)
    # ------------------------------------------------------------------
    def _guardar_snapshot(self, ads: List[Dict[str, Any]], estado: Dict[str, Any]) -> None:
        try:
            os.makedirs(os.path.dirname(self.snapshot_path), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.snapshot_path), suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"guardado": estado["actualizado"], "terminos": self.terms, "dias": self.days, "ads": ads}, f, ensure_ascii=False)
            os.replace(tmp, self.snapshot_path)
        except OSError as e:
            logger.warning(f"[AdLibrary] No se pudo guardar la copia local: {type(e).__name__}")

    def _leer_snapshot(self) -> Optional[Dict[str, Any]]:
        try:
            with open(self.snapshot_path, encoding="utf-8") as f:
                d = json.load(f)
            return d if isinstance(d.get("ads"), list) and d["ads"] else None
        except (OSError, ValueError):
            return None

    def obtener_nacional(self) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """Anuncios políticos nacionales (cacheados), sin duplicados, y un estado legible."""
        self.reload_token()
        if not self.configurado:
            return [], {
                "configurado": False,
                "ok": False,
                "mensaje": "Falta el token de Meta en la configuración privada de Firebase (/config/api_keys).",
            }

        with self._lock:
            if self._cache and time.time() - self._cache["ts"] < self.cache_ttl:
                return self._cache["ads"], self._cache["estado"]

            with ThreadPoolExecutor(max_workers=4) as ex:
                resultados = list(ex.map(self._fetch_term, self.terms))

            por_id: Dict[str, Dict[str, Any]] = {}
            errores: List[str] = []
            for crudos, err in resultados:
                if err:
                    errores.append(err)
                for raw in crudos:
                    ad = self._normalizar(raw)
                    if ad["id"] and ad["id"] not in por_id:
                        por_id[ad["id"]] = ad

            ads = list(por_id.values())
            if errores:
                logger.warning(f"[AdLibrary] {len(errores)} consulta(s) con error. Primera: {errores[0]}")

            snap = None
            if not ads and errores:
                snap = self._leer_snapshot()
                if snap:
                    ads = snap["ads"]

            estado = {
                "configurado": True,
                "ok": not errores or bool(ads),
                "total_nacional": len(ads),
                "terminos": self.terms,
                "dias": self.days,
                "cache_min": int(self.cache_ttl // 60),
                "version_api": self.version,
                "actualizado": datetime.now().isoformat(timespec="seconds"),
                "mensaje": "" if ads else (errores[0] if errores else
                                           "La API respondió sin anuncios para esos términos y período."),
            }
            if errores and ads and not snap:
                estado["advertencia"] = f"{len(errores)} de {len(self.terms)} consultas fallaron: {errores[0]}"
            if snap:
                guardado = snap.get("guardado", "")
                estado.update({
                    "desactualizado": True,
                    "actualizado": guardado,
                    "total_nacional": len(ads),
                    "mensaje": "",
                    "aviso": f"No se pudo consultar a Meta ({errores[0]}) Se muestran los últimos datos guardados, de {guardado[:16].replace('T', ' ')}.",
                })

            if snap or (errores and not ads):
                # Fallo: se recuerda 2 minutos para no repetir 16 consultas fallidas en cada petición.
                self._cache = {"ts": time.time() - self.cache_ttl + 120, "ads": ads, "estado": estado}
            else:
                self._cache = {"ts": time.time(), "ads": ads, "estado": estado}
                if ads and not errores:
                    self._guardar_snapshot(ads, estado)
            return ads, estado

    def _porcentaje_region(self, regiones: List[Dict[str, Any]], objetivo: str) -> Optional[float]:
        """Fracción del alcance en la provincia; None si el anuncio no trae datos regionales."""
        if not regiones:
            return None
        suma = 0.0
        for r in regiones:
            nombre = _norm(r["region"])
            if nombre and objetivo and (nombre == objetivo or objetivo in nombre or (len(nombre) >= 4 and nombre in objetivo)):
                suma += r["porcentaje"]
        return suma

    def por_provincia(self, provincia: str, limite: int = 15) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """Anuncios cuyo alcance incluye la provincia, ordenados por impresiones (rango alto)."""
        ads, estado = self.obtener_nacional()
        if not ads:
            return [], estado

        objetivo = _norm(provincia)
        elegidos = []
        for ad in ads:
            pct = self._porcentaje_region(ad["regiones"], objetivo)
            if pct is None:
                # Sin datos regionales: solo se incluye si el texto menciona la provincia.
                if not objetivo or objetivo not in _norm(ad["text"]):
                    continue
            elif pct < self.min_region_pct:
                continue
            elegidos.append({**ad, "porcentaje_provincia": pct})

        elegidos.sort(key=lambda a: ((a["impresiones"] or {}).get("max") or 0, a["date"]), reverse=True)
        return elegidos[:limite], {**estado, "total_provincia": len(elegidos)}

    def top_gastadores(self, provincia: Optional[str] = None, limite: int = 10) -> Dict[str, Any]:
        """
        Anunciantes políticos ordenados por inversión estimada (punto medio de los rangos de Meta).
        Con provincia, cada anuncio cuenta en proporción a su alcance allí (estimación).
        """
        ads, estado = self.obtener_nacional()
        objetivo = _norm(provincia) if provincia else ""
        if objetivo in ("todas", "ecuador", "ecuador todas"):
            objetivo = ""
        if not ads:
            return {"alcance": "provincia" if objetivo else "nacional", "anunciantes": [], "estado": estado}

        def medio(r: Optional[Dict[str, Optional[int]]]) -> float:
            if not r:
                return 0.0
            lo, hi = r.get("min"), r.get("max")
            if lo is None and hi is None:
                return 0.0
            if hi is None:
                return float(lo)
            if lo is None:
                return float(hi)
            return (lo + hi) / 2.0

        grupos: Dict[str, Dict[str, Any]] = {}
        for ad in ads:
            peso = 1.0
            if objetivo:
                pct = self._porcentaje_region(ad["regiones"], objetivo)
                if not pct or pct < self.min_region_pct:
                    continue
                peso = pct

            g = grupos.setdefault(str(ad["page_id"] or ad["page_name"]), {
                "page_name": ad["page_name"], "page_id": ad["page_id"], "moneda": ad["moneda"],
                "anuncios": 0, "activos": 0, "gasto_min": 0.0, "gasto_max": 0.0, "gasto_medio": 0.0,
                "impr_min": 0.0, "impr_max": 0.0, "impr_medio": 0.0,
                "financiadores": set(), "regiones": {}, "primero": "", "ultimo": "",
            })
            g["anuncios"] += 1
            g["activos"] += 1 if ad["activo"] else 0
            gasto, impr = ad["gasto"] or {}, ad["impresiones"] or {}
            g["gasto_min"] += (gasto.get("min") or 0) * peso
            g["gasto_max"] += (gasto.get("max") or gasto.get("min") or 0) * peso
            g["gasto_medio"] += medio(ad["gasto"]) * peso
            g["impr_min"] += (impr.get("min") or 0) * peso
            g["impr_max"] += (impr.get("max") or impr.get("min") or 0) * peso
            impr_medio = medio(ad["impresiones"]) * peso
            g["impr_medio"] += impr_medio
            if ad["financiador"]:
                g["financiadores"].add(ad["financiador"])
            for r in ad["regiones"]:
                nombre = _nombre_region(r["region"])
                g["regiones"][nombre] = g["regiones"].get(nombre, 0.0) + r["porcentaje"] * medio(ad["impresiones"])
            if ad["date"]:
                g["primero"] = min(g["primero"] or ad["date"], ad["date"])
                g["ultimo"] = max(g["ultimo"], ad["date"])

        anunciantes = []
        for g in grupos.values():
            total_reg = sum(g["regiones"].values())
            principal = max(g["regiones"].items(), key=lambda kv: kv[1]) if g["regiones"] else None
            anunciantes.append({
                "page_name": g["page_name"],
                "page_id": g["page_id"],
                "moneda": g["moneda"],
                "anuncios": g["anuncios"],
                "activos": g["activos"],
                "gasto": {"min": round(g["gasto_min"]), "max": round(g["gasto_max"]), "medio": round(g["gasto_medio"])},
                "impresiones": {"min": round(g["impr_min"]), "max": round(g["impr_max"]), "medio": round(g["impr_medio"])},
                "costo_por_mil": round(g["gasto_medio"] / g["impr_medio"] * 1000, 2) if g["impr_medio"] >= 10000 else None,
                "financiadores": sorted(g["financiadores"]),
                "pagado_por_tercero": any(not _misma_entidad(f, g["page_name"]) for f in g["financiadores"]),
                "region_principal": ({"region": principal[0], "porcentaje": round(principal[1] / total_reg, 3)}
                                     if principal and total_reg > 0 else None),
                "primer_anuncio": g["primero"],
                "ultimo_anuncio": g["ultimo"],
            })
        anunciantes.sort(key=lambda a: a["gasto"]["medio"], reverse=True)

        total_gasto = sum(a["gasto"]["medio"] for a in anunciantes)
        gasto_min_total = sum(a["gasto"]["min"] for a in anunciantes)
        gasto_max_total = sum(a["gasto"]["max"] for a in anunciantes)
        total_impr = sum(a["impresiones"]["medio"] for a in anunciantes)
        top5 = sum(a["gasto"]["medio"] for a in anunciantes[:5])

        # Un mismo financiador detrás de varias páginas distintas (posible red de páginas).
        paginas_por_financiador: Dict[str, set] = {}
        for ad in ads:
            if ad["financiador"]:
                paginas_por_financiador.setdefault(ad["financiador"], set()).add(ad["page_name"])
        redes = sorted(
            ({"financiador": f, "paginas": sorted(p)} for f, p in paginas_por_financiador.items() if len(p) >= 2),
            key=lambda r: len(r["paginas"]), reverse=True,
        )[:5]

        return {
            "alcance": "provincia" if objetivo else "nacional",
            "resumen": {
                "anunciantes": len(anunciantes),
                "anuncios": sum(a["anuncios"] for a in anunciantes),
                "gasto_medio_total": round(total_gasto),
                "gasto_min_total": gasto_min_total,
                "gasto_max_total": gasto_max_total,
                "impresiones_medias_total": round(total_impr),
                "concentracion_top5": round(top5 / total_gasto, 3) if total_gasto and len(anunciantes) >= 10 else None,
            },
            "anunciantes": anunciantes[:max(1, limite)],
            "redes_de_financiadores": redes,
            "estado": estado,
            "nota": "Meta publica rangos, no cifras exactas: la inversión es el punto medio de cada rango."
                    + (" Para una provincia, cada anuncio se prorratea por su porcentaje de alcance allí (estimación)." if objetivo else ""),
        }

    def buscar_texto(self, termino: str, limite: int = 5) -> Dict[str, Any]:
        """Anuncios (ya descargados y cacheados) cuyo texto o página contiene el término. No consume cuota de la API."""
        ads, estado = self.obtener_nacional()
        buscado = _norm(termino)
        if not ads or not buscado:
            return {"total": 0, "anuncios": [], "estado": estado}
        patron = re.compile(r"\b" + re.escape(buscado) + r"\b")
        coinciden = [a for a in ads if patron.search(_norm(a["text"])) or patron.search(_norm(a["page_name"]))]
        coinciden.sort(key=lambda a: ((a["impresiones"] or {}).get("max") or 0), reverse=True)
        gasto = sum(((a["gasto"] or {}).get("min") or 0) + ((a["gasto"] or {}).get("max") or (a["gasto"] or {}).get("min") or 0)
                    for a in coinciden) / 2.0
        return {
            "total": len(coinciden),
            "gasto_medio": round(gasto),
            "paginas": len({a["page_name"] for a in coinciden}),
            "anuncios": coinciden[:limite],
            "estado": estado,
        }

    def alcance_por_provincia(self) -> List[Dict[str, Any]]:
        """Impresiones estimadas por provincia: punto medio del rango × porcentaje de alcance de cada anuncio."""
        ads, _ = self.obtener_nacional()
        acumulado: Dict[str, Dict[str, float]] = {}
        for ad in ads:
            imp = ad["impresiones"] or {}
            lo, hi = imp.get("min"), imp.get("max")
            if lo is None and hi is None:
                continue
            medio = float(lo or 0) if hi is None else (float(hi or 0) if lo is None else (lo + hi) / 2.0)
            for r in ad["regiones"]:
                nombre = _nombre_region(r["region"])
                if not nombre or _norm(nombre) not in _PROVINCIAS_EC:
                    continue
                g = acumulado.setdefault(nombre, {"impresiones": 0.0, "anuncios": 0})
                g["impresiones"] += medio * r["porcentaje"]
                g["anuncios"] += 1
        total = sum(g["impresiones"] for g in acumulado.values()) or 1.0
        filas = [{"provincia": n, "impresiones": round(g["impresiones"]), "anuncios": int(g["anuncios"]),
                  "porcentaje": round(g["impresiones"] / total * 100, 1)} for n, g in acumulado.items()]
        filas.sort(key=lambda f: f["impresiones"], reverse=True)
        return filas

    def metricas_por_provincia(self) -> Dict[str, Any]:
        """
        Por provincia: impresiones e inversión estimadas (prorrateadas por el % de alcance de cada anuncio),
        número de anuncios y de anunciantes con alcance relevante. Alimenta el mapa de burbujas.
        """
        ads, estado = self.obtener_nacional()
        acumulado: Dict[str, Dict[str, Any]] = {}
        fuera = 0.0
        for ad in ads:
            imp, gasto = _medio(ad["impresiones"]), _medio(ad["gasto"])
            for r in ad["regiones"]:
                nombre = _nombre_region(r["region"])
                if not nombre:
                    continue
                if _norm(nombre) not in _PROVINCIAS_EC:
                    fuera += imp * r["porcentaje"]
                    continue
                g = acumulado.setdefault(nombre, {"impresiones": 0.0, "gasto": 0.0, "anuncios": 0, "paginas": set()})
                g["impresiones"] += imp * r["porcentaje"]
                g["gasto"] += gasto * r["porcentaje"]
                if r["porcentaje"] >= self.min_region_pct:
                    g["anuncios"] += 1
                    g["paginas"].add(ad["page_id"] or ad["page_name"])
        provincias = [
            {"provincia": n, "impresiones": round(g["impresiones"]), "gasto": round(g["gasto"]),
             "anuncios": g["anuncios"], "anunciantes": len(g["paginas"])}
            for n, g in acumulado.items()
        ]
        provincias.sort(key=lambda p: p["impresiones"], reverse=True)
        return {"provincias": provincias, "fuera_de_ecuador_impresiones": round(fuera), "estado": estado}

    def comparar(self, alcances: List[Optional[str]]) -> Dict[str, Any]:
        """Compara hasta 3 alcances (None = nacional): resumen, mayores anunciantes y anunciantes en común."""
        columnas = []
        listas: List[Dict[str, Dict[str, Any]]] = []
        estado: Dict[str, Any] = {}
        for provincia in alcances[:3]:
            top = self.top_gastadores(provincia, 500)
            estado = top.get("estado") or estado
            anunciantes = top.get("anunciantes") or []
            resumen = top.get("resumen") or {}
            dup = self.textos_duplicados(provincia, 1)
            columnas.append({
                "alcance": provincia or "Nacional",
                "resumen": {
                    **resumen,
                    "anuncios_activos": sum(a["activos"] for a in anunciantes),
                    "pagador_distinto": sum(1 for a in anunciantes if a["pagado_por_tercero"]),
                },
                "top": anunciantes[:5],
                "mensajes_repetidos": dup.get("total_grupos", 0),
            })
            listas.append({str(a["page_id"] or a["page_name"]): a for a in anunciantes})

        en_comun = []
        if len(listas) >= 2:
            claves = set(listas[0])
            for otra in listas[1:]:
                claves &= set(otra)
            for k in claves:
                nombre = listas[0][k]["page_name"]
                gastos = [l[k]["gasto"]["medio"] for l in listas]
                en_comun.append({"page_name": nombre, "page_id": listas[0][k]["page_id"], "gasto_medio": gastos})
            en_comun.sort(key=lambda e: sum(e["gasto_medio"]), reverse=True)

        return {"columnas": columnas, "en_comun": en_comun[:10], "total_en_comun": len(en_comun), "estado": estado}

    def textos_duplicados(self, provincia: Optional[str] = None, limite: int = 10,
                          umbral: float = 0.8) -> Dict[str, Any]:
        """
        Agrupa anuncios con texto casi idéntico (similitud de Jaccard sobre n-gramas de palabras)
        y devuelve los grupos que aparecen en 2 o más páginas distintas. Es un indicador de
        posible coordinación, no una prueba: partidos y gobiernos también reutilizan mensajes.
        """
        ads, estado = self.obtener_nacional()
        objetivo = _norm(provincia) if provincia else ""
        if objetivo in ("todas", "ecuador", "ecuador todas"):
            objetivo = ""
        base = {"alcance": "provincia" if objetivo else "nacional", "umbral": umbral, "grupos": [], "estado": estado}
        if not ads:
            return base

        candidatos = []
        retirados: Dict[str, int] = {}
        for ad in ads:
            if objetivo:
                pct = self._porcentaje_region(ad["regiones"], objetivo)
                if not pct or pct < self.min_region_pct:
                    continue
            limpio = re.sub(r"https?://\S+", " ", _norm(ad["text"]))
            if _PLACEHOLDER_RETIRADO.search(limpio):
                # Aviso estándar de Meta en lugar del anuncio retirado: se cuenta aparte.
                retirados[ad["page_name"]] = retirados.get(ad["page_name"], 0) + 1
                continue
            palabras = limpio.split()
            if len(palabras) < 8:  # textos muy cortos son genéricos y dan falsos positivos
                continue
            n = 3
            sh = {" ".join(palabras[i:i + n]) for i in range(len(palabras) - n + 1)}
            candidatos.append((ad, sh))

        # Índice invertido: solo se comparan anuncios que comparten al menos un n-grama.
        indice: Dict[str, List[int]] = {}
        for i, (_, sh) in enumerate(candidatos):
            for g in sh:
                indice.setdefault(g, []).append(i)

        padre = list(range(len(candidatos)))

        def raiz(x: int) -> int:
            while padre[x] != x:
                padre[x] = padre[padre[x]]
                x = padre[x]
            return x

        sim_min: Dict[int, float] = {}
        vistos = set()
        for i, (_, sh) in enumerate(candidatos):
            vecinos = set()
            for g in sh:
                vecinos.update(indice[g])
            for j in vecinos:
                if j <= i or (i, j) in vistos:
                    continue
                vistos.add((i, j))
                otro = candidatos[j][1]
                sim = len(sh & otro) / len(sh | otro)
                if sim >= umbral:
                    ri, rj = raiz(i), raiz(j)
                    if ri != rj:
                        padre[rj] = ri
                    r = raiz(i)
                    sim_min[r] = min(sim_min.get(r, 1.0), sim)

        grupos_idx: Dict[int, List[int]] = {}
        for i in range(len(candidatos)):
            grupos_idx.setdefault(raiz(i), []).append(i)

        def medio(r: Optional[Dict[str, Optional[int]]]) -> float:
            if not r:
                return 0.0
            lo, hi = r.get("min"), r.get("max")
            return float(lo or 0) if hi is None else (float(hi or 0) if lo is None else (lo + hi) / 2.0)

        grupos = []
        for idx in grupos_idx.values():
            miembros = [candidatos[i][0] for i in idx]
            paginas = {}
            for a in miembros:
                paginas.setdefault(a["page_name"], 0)
                paginas[a["page_name"]] += 1
            if len(paginas) < 2:
                continue
            financiadores = {a["financiador"] for a in miembros if a["financiador"]}
            entidades: List[str] = []
            for f in sorted(financiadores):
                if not any(_misma_entidad(f, e) for e in entidades):
                    entidades.append(f)
            fechas = sorted(a["date"] for a in miembros if a["date"])
            representante = max(miembros, key=lambda a: medio(a["impresiones"]))
            grupos.append({
                "texto": representante["text"][:400],
                "anuncios": len(miembros),
                "paginas": [{"page_name": p, "anuncios": c} for p, c in sorted(paginas.items(), key=lambda kv: -kv[1])],
                "n_paginas": len(paginas),
                "financiadores": sorted(financiadores),
                "financiadores_distintos": len(entidades) >= 2,
                "gasto_medio": round(sum(medio(a["gasto"]) for a in miembros)),
                "impresiones_medias": round(sum(medio(a["impresiones"]) for a in miembros)),
                "primer_anuncio": fechas[0] if fechas else "",
                "ultimo_anuncio": fechas[-1] if fechas else "",
                "similitud_minima": round(sim_min.get(raiz(idx[0]), 1.0), 2),
                "ejemplo_link": representante["link"],
            })

        grupos.sort(key=lambda g: (g["n_paginas"], g["gasto_medio"]), reverse=True)
        return {
            **base,
            "analizados": len(candidatos),
            "retirados_por_meta": {
                "anuncios": sum(retirados.values()),
                "paginas": [{"page_name": p, "anuncios": c} for p, c in sorted(retirados.items(), key=lambda kv: -kv[1])[:5]],
            },
            "total_grupos": len(grupos),
            "grupos": grupos[:max(1, limite)],
            "nota": "Textos con similitud ≥ %d %% entre páginas distintas. Es un indicador, no una prueba: "
                    "campañas, partidos y gobiernos también reutilizan mensajes. Más relevante cuando los "
                    "financiadores declarados son distintos." % round(umbral * 100),
        }

    def diagnostico(self) -> Dict[str, Any]:
        """Prueba mínima contra la API para comprobar token, versión y cobertura de Ecuador."""
        base = {"configurado": self.configurado, "version_api": self.version, "pais": self.country}
        if not self.configurado:
            return {**base, "ok": False, "mensaje": "Falta el token de Meta en la configuración privada de Firebase (/config/api_keys)."}

        crudos, err = self._fetch_term("elecciones", limit=5, pages=1)
        if err:
            return {**base, "ok": False, "error": err}

        primero = crudos[0] if crudos else {}
        regiones = [r.get("region") for r in (primero.get("delivery_by_region") or []) if isinstance(r, dict)]
        return {
            **base,
            "ok": True,
            "anuncios_devueltos": len(crudos),
            "campos_recibidos": sorted(primero.keys()),
            "regiones_ejemplo": regiones[:10],
            "mensaje": "" if crudos else
                       "La API respondió pero sin anuncios para 'elecciones'. Prueba otros términos en AD_LIBRARY_TERMS.",
        }
