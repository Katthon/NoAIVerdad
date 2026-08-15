#!/usr/bin/env bash
echo "Iniciando backend NoAIVerdad en Railway..."
cd backend
pip install -r requirements.txt
exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
