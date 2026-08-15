#!/usr/bin/env bash
echo "Iniciando servicio Frontend NoAIVerdad en Railway en el puerto $PORT..."
npx -y serve . -p ${PORT:-3000}
