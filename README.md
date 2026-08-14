# NoAIVerdad - Plataforma Cívica para Monitoreo Electoral en Ecuador 🇪🇨

**NoAIVerdad** es una plataforma cívica 100% open-source diseñada para monitorear anuncios políticos electorales y detectar patrones de desinformación en Ecuador a nivel provincial, integrando **Leaflet.js**, **OpenStreetMap** y la **Meta Ad Library API** con un backend en **FastAPI**.

---

## 📁 Estructura del Proyecto

```text
NoAIVerdad/
├── backend/
│   ├── main.py              # Servidor principal FastAPI y endpoints de la API
│   ├── meta_service.py      # Servicio de integración con Meta Ad Library API y filtrado geográfico
│   ├── .env.example         # Plantilla de variables de entorno (Token Meta, Puerto, Host)
│   └── requirements.txt     # Dependencias del backend (FastAPI, Uvicorn, Requests, Python-Dotenv)
├── frontend/
│   ├── index.html           # Interfaz HTML principal (OpenStreetMap + Leaflet.js + Sidebar)
│   ├── css/
│   │   └── styles.css       # Estilos CSS modernos (Glassmorphism, Responsive, UI/UX prémium)
│   ├── js/
│   │   └── app.js           # Lógica JavaScript (Leaflet map, L.geoJSON, eventos y fetch backend)
│   └── data/
│       └── ecuador_provincias.geojson # Polígonos GeoJSON de las 24 provincias de Ecuador
└── README.md                # Guía de instalación y ejecución local
```

---

## 📌 Ubicación del Archivo GeoJSON

El archivo `ecuador_provincias.geojson` debe ir dentro de la subcarpeta `data` del frontend:
👉 `frontend/data/ecuador_provincias.geojson`

El código en `frontend/js/app.js` lo consume de forma asíncrona mediante la ruta relativa `data/ecuador_provincias.geojson`.

---

## 🚀 Guía de Instalación y Ejecución Local

### 1. Configuración del Backend (Python / FastAPI)

1. **Accede al directorio del backend:**
   ```bash
   cd backend
   ```

2. **Crea y activa un entorno virtual de Python:**
   - En Linux/macOS:
     ```bash
     python3 -m venv venv
     source venv/bin/activate
     ```
   - En Windows (PowerShell):
     ```powershell
     python -m venv venv
     .\venv\Scripts\Activate.ps1
     ```

3. **Instala las dependencias necesarias:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Configura el archivo de variables de entorno `.env`:**
   ```bash
   cp .env.example .env
   ```
   Edita el archivo `.env` e ingresa tu token de Meta si lo tienes disponible:
   ```env
   META_APP_ID=1035383682616354
   META_ACCESS_TOKEN=TU_META_ACCESS_TOKEN_REAL
   PORT=8000
   HOST=0.0.0.0
   ```
   > 💡 **Nota:** Si no configuras el `META_ACCESS_TOKEN`, la aplicación se ejecutará en **Modo Demostración** devolviendo noticias y anuncios sintéticos de prueba para la provincia seleccionada.

5. **Inicia el servidor backend:**
   ```bash
   python main.py
   ```
   - API corriendo en: `http://localhost:8000`
   - Documentación Swagger en: `http://localhost:8000/docs`

---

### 2. Ejecutar el Frontend (Leaflet.js + OpenStreetMap)

1. **No requiere clave de API**: Al usar OpenStreetMap y Leaflet.js, no necesitas ninguna API Key de terceros ni tarjeta de crédito.

2. **Servir el Frontend localmente:**
   Para evitar bloqueos de Origen Cruzado (CORS / `file://`), sirve la carpeta `frontend` mediante un servidor local básico:

   - **Usando Python en el directorio `frontend`:**
     ```bash
     cd frontend
     python3 -m http.server 3000
     ```
     Abre tu navegador en: `http://localhost:3000`

---

## 🎯 Funcionalidades e Interacción

1. El mapa se inicializa centrado en Ecuador (`Lat: -1.8312, Lng: -78.1834`, Zoom: 7) con la capa base de OpenStreetMap.
2. Se cargan los polígonos de las **24 provincias de Ecuador** desde `frontend/data/ecuador_provincias.geojson`.
3. **Hover**: Al pasar el ratón, la provincia se ilumina suavemente.
4. **Clic**:
   - El mapa realiza un **zoom suave** hacia los límites de la provincia (`map.fitBounds`).
   - La provincia cambia a color de selección activada.
   - El título del panel lateral (Sidebar) se actualiza dinámicamente a `"Noticias en: [Nombre de la Provincia]"`.
   - Se realiza una consulta `fetch` al backend FastAPI (`GET /api/noticias?provincia=...`) y se renderizan las tarjetas de noticias/anuncios.
