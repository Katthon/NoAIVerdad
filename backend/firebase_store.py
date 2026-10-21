"""Firebase Realtime Database access for trusted server-side jobs."""

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

API_KEY_FIELDS = (
    "GNEWS_API_KEY",
    "GOOGLE_FACT_CHECK_API_KEY",
    "FB_META_ACCESS_TOKEN",
    "FB_META_API_ENABLED",
    "GROK_API_KEY",
    "BLUESKY_HANDLE",
    "BLUESKY_APP_PASSWORD",
)

try:
    import firebase_admin
    from firebase_admin import credentials, db
except ImportError:  # Keep API routes usable when the optional deployment dependency is absent.
    firebase_admin = None
    credentials = None
    db = None


def initialize() -> bool:
    """Initialize Admin SDK using a server-only service account or cloud ADC."""
    if firebase_admin is None:
        logger.error("firebase-admin no está instalado; el colector no puede guardar datos.")
        return False

    if firebase_admin._apps:
        return True

    database_url = os.getenv(
        "FIREBASE_DATABASE_URL",
        "https://noaiverdad-72aba-default-rtdb.firebaseio.com",
    ).rstrip("/")

    try:
        service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
        service_account_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()

        if service_account_json:
            credential = credentials.Certificate(json.loads(service_account_json))
        elif service_account_path:
            path = Path(service_account_path).expanduser()
            if not path.is_file():
                logger.error("No existe el archivo configurado en GOOGLE_APPLICATION_CREDENTIALS.")
                return False
            credential = credentials.Certificate(str(path))
        elif os.getenv("K_SERVICE") or os.getenv("GOOGLE_CLOUD_PROJECT"):
            credential = credentials.ApplicationDefault()
        else:
            logger.warning(
                "Colector desactivado: configura GOOGLE_APPLICATION_CREDENTIALS "
                "con la ruta privada de una cuenta de servicio de Firebase."
            )
            return False

        firebase_admin.initialize_app(credential, {"databaseURL": database_url})
        logger.info("Firebase Admin listo para guardar datos del colector.")
        return True
    except Exception:
        logger.exception("No se pudo inicializar Firebase Admin.")
        return False


def get(path: str):
    if not initialize():
        return None
    return db.reference(path).get()


def get_api_keys() -> dict[str, str]:
    """Read third-party API credentials from the private RTDB config node."""
    try:
        value = get("config/api_keys")
    except Exception:
        logger.exception("No se pudieron leer las credenciales privadas desde Firebase.")
        return {}
    if not isinstance(value, dict):
        logger.warning("No existe el nodo privado config/api_keys en Firebase.")
        return {}

    return {
        field: value[field].strip()
        for field in API_KEY_FIELDS
        if isinstance(value.get(field), str) and value[field].strip()
    }


def set_value(path: str, value) -> bool:
    if not initialize():
        return False
    db.reference(path).set(value)
    return True
