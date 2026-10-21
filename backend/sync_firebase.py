"""Run one server-side collection cycle and persist all provinces to Firebase."""

import logging
import sys

from dotenv import load_dotenv

load_dotenv()

import firebase_store
from meta_service import UnifiedFeedService
from news_collector import refresh_all


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    if not firebase_store.initialize():
        print("No se ejecutó la sincronización: configura credenciales Firebase Admin en backend/.env.")
        sys.exit(1)

    result = refresh_all(UnifiedFeedService())
    print(f"Sincronización finalizada: {result}")
    sys.exit(0 if result["guardadas"] > 0 else 1)
