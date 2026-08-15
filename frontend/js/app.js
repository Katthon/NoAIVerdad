/**
 * NoAIVerdad - Frontend Logic (Leaflet.js + Hero Search + Dashboard Chart.js)
 * Plataforma Cívica para Monitoreo Electoral en Ecuador.
 */

// Obtener la URL del backend dinámicamente según el entorno de ejecución (localhost vs producción Railway)
const obtenerBackendUrl = () => {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';

    // Si estamos ejecutando en la computadora local (localhost)
    if (isLocal) {
      console.log("[Entorno Local Detectado] Conectando a FastAPI local en http://localhost:8000");
      return 'http://localhost:8000';
    }

    // Si estamos ejecutando en producción (Railway, Vercel, Netlify, GitHub Pages)
    if (window.VITE_API_URL) return window.VITE_API_URL;
    if (window.API_URL) return window.API_URL;
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) {
      return import.meta.env.VITE_API_URL;
    }
  } catch (e) {}

  return 'https://noaiverdad-production.up.railway.app';
};

// Estado global de la aplicación
const state = {
  map: null,
  marcadores: {},
  provinciaSeleccionada: null,
  backendUrl: obtenerBackendUrl(),
  chartsInicializados: false,
  charts: {},
  datosActuales: null,       // Guardar respuesta raw del backend
  filtroSeccion: "noticias", // 'noticias' | 'verificaciones' | 'tweets' | 'bluesky' | 'meta_ads'
  filtroAnio: "todos",        // 'todos' | '2026' | '2025' | '2024' | '2023'
  feedCache: {}              // Cache client-side: feedCache[provincia][seccion]
};

/**
 * 1. DATOS CENTRALIZADOS: Centroides y Capitales de las 24 Provincias de Ecuador
 */
const provinciasEcuador = [
  { id: 'azuay', nombre: 'Azuay', capital: 'Cuenca', lat: -2.9001, lng: -79.0059 },
  { id: 'bolivar', nombre: 'Bolívar', capital: 'Guaranda', lat: -1.5925, lng: -79.0030 },
  { id: 'canar', nombre: 'Cañar', capital: 'Azogues', lat: -2.7397, lng: -78.8486 },
  { id: 'carchi', nombre: 'Carchi', capital: 'Tulcán', lat: 0.8115, lng: -77.7171 },
  { id: 'chimborazo', nombre: 'Chimborazo', capital: 'Riobamba', lat: -1.6636, lng: -78.6546 },
  { id: 'cotopaxi', nombre: 'Cotopaxi', capital: 'Latacunga', lat: -0.9328, lng: -78.6155 },
  { id: 'el_oro', nombre: 'El Oro', capital: 'Machala', lat: -3.2581, lng: -79.9554 },
  { id: 'esmeraldas', nombre: 'Esmeraldas', capital: 'Esmeraldas', lat: 0.9592, lng: -79.6536 },
  { id: 'galapagos', nombre: 'Galápagos', capital: 'Puerto Baquerizo Moreno', lat: -0.9010, lng: -89.6013 },
  { id: 'guayas', nombre: 'Guayas', capital: 'Guayaquil', lat: -2.1894, lng: -79.8891 },
  { id: 'imbabura', nombre: 'Imbabura', capital: 'Ibarra', lat: 0.3392, lng: -78.1222 },
  { id: 'loja', nombre: 'Loja', capital: 'Loja', lat: -3.9931, lng: -79.2042 },
  { id: 'los_rios', nombre: 'Los Ríos', capital: 'Babahoyo', lat: -1.8022, lng: -79.5344 },
  { id: 'manabi', nombre: 'Manabí', capital: 'Portoviejo', lat: -1.0546, lng: -80.4544 },
  { id: 'morona_santiago', nombre: 'Morona Santiago', capital: 'Macas', lat: -2.3023, lng: -78.1182 },
  { id: 'napo', nombre: 'Napo', capital: 'Tena', lat: -0.9938, lng: -77.8129 },
  { id: 'orellana', nombre: 'Orellana', capital: 'Puerto Francisco de Orellana', lat: -0.4665, lng: -76.9872 },
  { id: 'pastaza', nombre: 'Pastaza', capital: 'Puyo', lat: -1.4837, lng: -78.0026 },
  { id: 'pichincha', nombre: 'Pichincha', capital: 'Quito', lat: -0.2298, lng: -78.5250 },
  { id: 'santa_elena', nombre: 'Santa Elena', capital: 'Santa Elena', lat: -2.2270, lng: -80.8594 },
  { id: 'santo_domingo', nombre: 'Santo Domingo de los Tsáchilas', capital: 'Santo Domingo', lat: -0.2530, lng: -79.1754 },
  { id: 'sucumbios', nombre: 'Sucumbíos', capital: 'Nueva Loja', lat: 0.0847, lng: -76.8828 },
  { id: 'tungurahua', nombre: 'Tungurahua', capital: 'Ambato', lat: -1.2417, lng: -78.6195 },
  { id: 'zamora_chinchipe', nombre: 'Zamora Chinchipe', capital: 'Zamora', lat: -4.0692, lng: -78.9567 }
];

// Inicializar al cargar el DOM
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initNavListeners();
  initSearchListeners();
  initFilterListeners();
});

/**
 * Inicializa Leaflet.js centrado en Ecuador
 */
function initMap() {
  console.log("Inicializando mapa de Ecuador con marcadores tipo province-dot...");

  // Configurar mapa centrado en Ecuador (-1.8312, -78.1834) zoom nivel 7
  state.map = L.map("map", {
    center: [-1.8312, -78.1834],
    zoom: 7,
    zoomControl: true
  });

  // Capa base de OpenStreetMap (estándar y gratuita)
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | NoAIVerdad'
  }).addTo(state.map);

  // Iterar y renderizar los marcadores para cada provincia
  crearMarcadoresProvincia();

  // Forzar recálculo de dimensiones inmediatamente
  setTimeout(() => {
    if (state.map) {
      state.map.invalidateSize();
    }
  }, 250);

  window.addEventListener("resize", () => {
    if (state.map) {
      state.map.invalidateSize();
    }
  });
}

/**
 * Iteración de marcadores en el mapa usando L.divIcon, iconAnchor [7, 7] y Tooltip nativo
 */
function crearMarcadoresProvincia() {
  provinciasEcuador.forEach((provincia) => {
    const icon = L.divIcon({
      className: "province-dot-marker-wrapper",
      html: `<div class="province-dot" id="dot-${provincia.id}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });

    const marker = L.marker([provincia.lat, provincia.lng], { icon: icon }).addTo(state.map);

    marker.bindTooltip(`<b>${provincia.nombre}</b>`, {
      direction: "top",
      offset: [0, -10],
      className: "custom-province-tooltip"
    });

    state.marcadores[provincia.nombre] = { marker, data: provincia, id: provincia.id };

    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      seleccionarProvincia(provincia);
    });
  });
}

/**
 * Colapsa la sección del Hero Banner para liberar espacio al mapa interactivo
 */
function colapsarHero() {
  const heroBanner = document.querySelector(".hero-banner");
  if (heroBanner && !heroBanner.classList.contains("collapsed")) {
    heroBanner.classList.add("collapsed");
    setTimeout(() => {
      if (state.map) state.map.invalidateSize();
    }, 400);
  }
}

/**
 * Expande la sección del Hero Banner manteniendo intacta la búsqueda activa del usuario
 */
function expandirHero() {
  const heroBanner = document.querySelector(".hero-banner");
  if (heroBanner) {
    heroBanner.classList.remove("collapsed");
  }

  // Volver al mapa si estábamos en el dashboard
  document.getElementById("view-dashboard")?.classList.remove("active");
  document.getElementById("nav-btn-dashboard")?.classList.remove("active");
  document.getElementById("view-mapa")?.classList.add("active");

  // Recalcular dimensiones del mapa Leaflet
  setTimeout(() => {
    if (state.map) {
      state.map.invalidateSize();
    }
  }, 400);
}

/**
 * EventListeners para la Navegación por Pestañas y Marca
 */
function initNavListeners() {
  const btnDashboard = document.getElementById("nav-btn-dashboard");
  const viewMapa = document.getElementById("view-mapa");
  const viewDashboard = document.getElementById("view-dashboard");
  const brandLogo = document.querySelector(".brand-container");

  if (brandLogo) {
    brandLogo.addEventListener("click", expandirHero);
  }

  if (btnDashboard) {
    btnDashboard.addEventListener("click", () => {
      const estaActivo = viewDashboard?.classList.contains("active");

      if (estaActivo) {
        expandirHero();
      } else {
        btnDashboard.classList.add("active");
        viewDashboard?.classList.add("active");
        viewMapa?.classList.remove("active");

        if (!state.chartsInicializados) {
          inicializarChartsDashboard();
        }
      }
    });
  }
}

/**
 * EventListeners para el Buscador de Provincias en el Hero
 */
function initSearchListeners() {
  const selectProvincia = document.getElementById("hero-province-select");
  const btnBuscar = document.getElementById("hero-search-btn");

  const ejecutarBusqueda = () => {
    const selectedId = selectProvincia.value;
    if (!selectedId) {
      alert("Por favor selecciona una provincia de Ecuador.");
      return;
    }

    const provinciaObj = provinciasEcuador.find(p => p.id === selectedId);
    if (provinciaObj) {
      document.getElementById("view-dashboard")?.classList.remove("active");
      document.getElementById("nav-btn-dashboard")?.classList.remove("active");
      document.getElementById("view-mapa")?.classList.add("active");

      setTimeout(() => {
        if (state.map) state.map.invalidateSize();
        seleccionarProvincia(provinciaObj);
      }, 100);
    }
  };

  if (btnBuscar) {
    btnBuscar.addEventListener("click", ejecutarBusqueda);
  }

  if (selectProvincia) {
    selectProvincia.addEventListener("change", ejecutarBusqueda);
  }
}

/**
 * EventListeners para los Filtros Separados del Sidebar (Sección y Año)
 */
function initFilterListeners() {
  const filterSection = document.getElementById("filter-section");
  const filterYear = document.getElementById("filter-year");

  if (filterSection) {
    state.filtroSeccion = filterSection.value || "noticias";

    filterSection.addEventListener("change", (e) => {
      state.filtroSeccion = e.target.value;
      if (state.provinciaSeleccionada) {
        cargarNoticiasBackend(state.provinciaSeleccionada, state.filtroSeccion);
      }
    });
  }

  if (filterYear) {
    filterYear.addEventListener("change", (e) => {
      state.filtroAnio = e.target.value;
      if (state.datosActuales) {
        renderizarResultados(state.datosActuales);
      }
    });
  }
}

/**
 * Lógica al seleccionar una provincia (flyTo a las coordenadas centrales y carga del backend)
 */
function seleccionarProvincia(provincia) {
  console.log(`Cargando noticias de ${provincia.nombre}...`);

  // Sincronizar el select del Hero
  const selectProvincia = document.getElementById("hero-province-select");
  if (selectProvincia && provincia.id) {
    selectProvincia.value = provincia.id;
  }

  // Colapsar el buscador Hero para enfocar el mapa
  colapsarHero();

  // Desactivar el punto activo anterior
  if (state.provinciaSeleccionada) {
    const prevId = state.marcadores[state.provinciaSeleccionada]?.id;
    if (prevId) {
      document.getElementById(`dot-${prevId}`)?.classList.remove("active");
    }
  }

  // Activar el punto de la provincia seleccionada
  const currentId = provincia.id;
  if (currentId) {
    document.getElementById(`dot-${currentId}`)?.classList.add("active");
  }

  state.provinciaSeleccionada = provincia.nombre;

  // Zoom suave (flyTo) a la capital/centroide
  state.map.flyTo([provincia.lat, provincia.lng], 9, {
    animate: true,
    duration: 1.2
  });

  // Actualizar la interfaz del panel lateral
  actualizarSidebar(provincia.nombre);

  // Petición rápida al backend por la sección seleccionada (< 1s)
  cargarNoticiasBackend(provincia.nombre, state.filtroSeccion);
}

/**
 * Actualiza el título dinámico del panel lateral
 */
function actualizarSidebar(nombreProvincia) {
  const sidebarTitle = document.getElementById("sidebar-title");
  const selectedBadge = document.getElementById("selected-province-badge");

  if (sidebarTitle) {
    sidebarTitle.textContent = `Noticias en: ${nombreProvincia}`;
  }
  if (selectedBadge) {
    selectedBadge.textContent = nombreProvincia;
  }
}

function obtenerNombreSeccion(seccion) {
  const nombres = {
    noticias: "Noticias de Prensa",
    verificaciones: "Fact-Check / Posibles Falsas",
    tweets: "X (Twitter)",
    bluesky: "Bluesky"
  };
  return nombres[seccion] || seccion;
}

/**
 * Petición fetch on-demand al backend para obtener noticias por sección (< 1s)
 */
async function cargarNoticiasBackend(provincia, seccion = state.filtroSeccion) {
  const sidebarContent = document.getElementById("sidebar-content");
  state.filtroSeccion = seccion;

  // Inicializar cache para la provincia si no existe
  if (!state.feedCache[provincia]) {
    state.feedCache[provincia] = {};
  }

  // Si la sección ya fue descargada con datos válidos para esta provincia, cargar de inmediato (0ms)
  const cached = state.feedCache[provincia]?.[seccion];
  if (cached && (
      (cached.tiempo_real && cached.tiempo_real.length > 0) ||
      (cached.verificaciones && cached.verificaciones.length > 0) ||
      (cached.tweets_recientes && cached.tweets_recientes.length > 0) ||
      (cached.bluesky_posts && cached.bluesky_posts.length > 0) ||
      (cached.meta_ads && cached.meta_ads.length > 0)
  )) {
    console.log(`[Cache Hit] Carga instantánea de '${seccion}' para ${provincia}`);
    state.datosActuales = cached;
    renderizarResultados(state.datosActuales);
    return;
  }

  sidebarContent.innerHTML = `
    <div class="state-box">
      <div class="spinner"></div>
      <div class="state-title">Cargando ${escaparHtml(obtenerNombreSeccion(seccion))}...</div>
      <div class="state-desc">Consultando la sección <strong>${escaparHtml(obtenerNombreSeccion(seccion))}</strong> en <strong>${provincia}</strong>.</div>
    </div>
  `;

  try {
    const endpoint = `${state.backendUrl}/api/noticias?provincia=${encodeURIComponent(provincia)}&seccion=${encodeURIComponent(seccion)}`;
    const response = await fetch(endpoint);

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const data = await response.json();
    state.feedCache[provincia][seccion] = data;
    state.datosActuales = data;
    renderizarResultados(data);

  } catch (error) {
    console.error("Error al conectar con el backend:", error);
    sidebarContent.innerHTML = `
      <div class="state-box">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
        <div class="state-title">Error de conexión</div>
        <div class="state-desc">No se pudo obtener datos del servidor FastAPI para <strong>${provincia}</strong>.<br><br><small>${error.message}</small></div>
      </div>
    `;
  }
}

/**
 * Helpers para el filtrado por año
 */
function obtenerAnioItem(item) {
  const textDate = item.date || item.fecha || item.date_created || item.pubDate || item.anio || "";
  const match = String(textDate).match(/\b(202[0-9])\b/);
  if (match) return match[1];
  if (item.anio) return String(item.anio);
  return "2026";
}

function itemCumpleAnio(item, filtroAnio) {
  if (filtroAnio === "todos") return true;
  const anio = obtenerAnioItem(item);
  if (filtroAnio === "2023") {
    return parseInt(anio) <= 2023;
  }
  return anio === filtroAnio;
}

function formatearFechaSafe(fechaStr) {
  if (!fechaStr) return "";
  try {
    const d = new Date(fechaStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('es-EC', { day: 'numeric', month: 'short', year: 'numeric' });
    }
  } catch (e) {}
  return String(fechaStr);
}

/**
 * Renderiza el feed unificado en tiempo real con filtrado por Sección y Año (Prensa, Fact-Check, X, Bluesky, Meta Ads)
 */
function renderizarResultados(data) {
  const sidebarContent = document.getElementById("sidebar-content");
  const seccion = state.filtroSeccion;
  const anio = state.filtroAnio;

  const rawNoticias = data.tiempo_real || [];
  const rawVerificaciones = data.verificaciones || [];
  const rawTweets = data.tweets_recientes || [];
  const rawBluesky = data.bluesky_posts || [];
  const rawMetaAds = data.meta_ads || [];

  const noticias = (seccion === "todas" || seccion === "noticias")
    ? rawNoticias.filter(item => itemCumpleAnio(item, anio))
    : [];

  const verificaciones = (seccion === "todas" || seccion === "verificaciones")
    ? rawVerificaciones.filter(item => itemCumpleAnio(item, anio))
    : [];

  const tweets = (seccion === "todas" || seccion === "tweets")
    ? rawTweets.filter(item => itemCumpleAnio(item, anio))
    : [];

  const blueskyPosts = (seccion === "todas" || seccion === "bluesky")
    ? rawBluesky.filter(item => itemCumpleAnio(item, anio))
    : [];

  const metaAds = (seccion === "todas" || seccion === "meta_ads")
    ? rawMetaAds.filter(item => itemCumpleAnio(item, anio))
    : [];

  const totalElementos = noticias.length + verificaciones.length + tweets.length + blueskyPosts.length + metaAds.length;

  if (totalElementos === 0) {
    sidebarContent.innerHTML = `
      <div class="state-box">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/>
        </svg>
        <div class="state-title">Sin resultados para los filtros aplicados</div>
        <div class="state-desc">No se encontraron publicaciones en <strong>${escaparHtml(data.provincia)}</strong> para la sección <em>"${escaparHtml(seccion)}"</em> y año <em>"${escaparHtml(anio)}"</em>.<br><br>Prueba seleccionando <strong>"Todas las secciones"</strong> o <strong>"Todos los años"</strong>.</div>
      </div>
    `;
    return;
  }

  let html = "";

  // 1. SECCIÓN: Noticias en Tiempo Real
  if (noticias.length > 0) {
    html += `
      <div class="section-title-container" style="margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 10px; height: 10px; background-color: #4f46e5; border-radius: 50%;"></span>
          <h3 style="font-size: 0.95rem; font-weight: 700; color: #0f172a;">Noticias en Tiempo Real (${noticias.length})</h3>
        </div>
        <span style="font-size: 0.75rem; color: #64748b;">Prensa Ecuador</span>
      </div>
    `;

    noticias.forEach((n) => {
      const fechaFormatted = formatearFechaSafe(n.fecha);

      html += `
        <div class="ad-card" style="border-left: 4px solid #4f46e5;">
          <div class="ad-card-header">
            <div class="ad-page-name">${escaparHtml(n.fuente)}</div>
            <span style="font-size: 0.75rem; color: #94a3b8;">${fechaFormatted}</span>
          </div>

          <div class="ad-title" style="color: #1e293b; font-weight: 600;">
            ${escaparHtml(n.titulo)}
          </div>

          <div class="ad-footer" style="margin-top: 12px;">
            <span style="font-size: 0.75rem; color: #64748b;">Noticia</span>
            <a href="${n.url}" target="_blank" rel="noopener noreferrer" class="btn-meta">
              Leer Noticia
            </a>
          </div>
        </div>
      `;
    });
  }

  // 2. SECCIÓN: Revisiones y Fact-Checking (Con bloque de Advertencia)
  if (verificaciones.length > 0) {
    html += `
      <div class="section-title-container" style="margin-top: 20px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 10px; height: 10px; background-color: #ef4444; border-radius: 50%;"></span>
          <h3 style="font-size: 0.95rem; font-weight: 700; color: #0f172a;">Fact-Checking / Verificaciones (${verificaciones.length})</h3>
        </div>
        <span style="font-size: 0.75rem; color: #64748b;">Google Fact Check</span>
      </div>
    `;

    verificaciones.forEach((v) => {
      const rating = v.textualRating || "Revisado";
      const ratingLower = rating.toLowerCase();
      
      const esFalso = ratingLower.includes("fals") || 
                      ratingLower.includes("engaño") || 
                      ratingLower.includes("incorrect") || 
                      ratingLower.includes("fake") || 
                      ratingLower.includes("alterad") || 
                      ratingLower.includes("manipulad");

      let warningHtml = "";
      if (esFalso) {
        warningHtml = `
          <div style="margin-top: 10px; margin-bottom: 10px; padding: 10px 12px; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 8px; font-size: 0.825rem; color: #9f1239; display: flex; align-items: flex-start; gap: 8px;">
            <svg style="flex-shrink: 0; margin-top: 2px; width: 16px; height: 16px; color: #e11d48;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
            <div>
              <strong>⚠️ Advertencia:</strong> Cuidado, <strong>${escaparHtml(v.publisher)}</strong> (vía Google) lo clasificó como <span style="font-weight: 700; text-decoration: underline;">"${escaparHtml(rating)}"</span>.
            </div>
          </div>
        `;
      } else if (rating) {
        warningHtml = `
          <div style="margin-top: 10px; margin-bottom: 10px; padding: 10px 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; font-size: 0.825rem; color: #1e40af; display: flex; align-items: flex-start; gap: 8px;">
            <svg style="flex-shrink: 0; margin-top: 2px; width: 16px; height: 16px; color: #3b82f6;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <div>
              <strong>Información de Fact-Check:</strong> Clasificado como <strong>"${escaparHtml(rating)}"</strong> por ${escaparHtml(v.publisher)}.
            </div>
          </div>
        `;
      }

      html += `
        <div class="ad-card" style="border-left: 4px solid ${esFalso ? '#ef4444' : '#06b6d4'};">
          <div class="ad-card-header">
            <div class="ad-page-name" style="font-size: 0.85rem; color: #475569;">
              Afirma: <strong>${escaparHtml(v.claimant)}</strong>
            </div>
            <span class="ad-reach-badge" style="background: ${esFalso ? '#fef2f2' : '#e0f2fe'}; color: ${esFalso ? '#991b1b' : '#0369a1'}; border: 1px solid ${esFalso ? '#fecaca' : '#bae6fd'}; font-weight: 600;">
              ${esFalso ? '⚠️ Advertencia' : 'Fact-Check'}
            </span>
          </div>

          <div class="ad-title" style="color: #0f172a; font-size: 0.925rem; margin-bottom: 8px;">
            "${escaparHtml(v.text)}"
          </div>

          ${warningHtml}

          <div class="ad-footer">
            <span style="font-size: 0.75rem; color: #64748b;">
              Fuente: <strong>${escaparHtml(v.publisher)}</strong>
            </span>
            <a href="${v.url}" target="_blank" rel="noopener noreferrer" class="btn-meta" style="background: ${esFalso ? '#dc2626' : '#0284c7'};">
              Ver Fact-Check
            </a>
          </div>
        </div>
      `;
    });
  }

  // 3. SECCIÓN: Publicaciones en X (Twitter)
  if (tweets.length > 0) {
    html += `
      <div class="section-title-container" style="margin-top: 20px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 10px; height: 10px; background-color: #1d9bf0; border-radius: 50%;"></span>
          <h3 style="font-size: 0.95rem; font-weight: 700; color: #0f172a;">Publicaciones en X / Twitter (${tweets.length})</h3>
        </div>
        <span style="font-size: 0.75rem; color: #1d9bf0; font-weight: 600;">Redes Sociales</span>
      </div>
    `;

    tweets.forEach((tw) => {
      const user = tw.user || {};
      const stats = tw.stats || {};

      html += `
        <div class="ad-card" style="border-left: 4px solid #1d9bf0;">
          <div class="ad-card-header" style="margin-bottom: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="font-weight: 700; font-size: 0.9rem; color: #0f172a;">${escaparHtml(user.name || 'Usuario X')}</div>
              <div style="font-size: 0.8rem; color: #64748b;">${escaparHtml(user.username || '')}</div>
            </div>
            <span style="font-size: 0.75rem; color: #94a3b8;">${escaparHtml(tw.date || '')}</span>
          </div>

          <div class="ad-body" style="font-size: 0.875rem; color: #1e293b; line-height: 1.45; margin-bottom: 12px;">
            ${escaparHtml(tw.text)}
          </div>

          <div class="ad-meta-grid">
            <div>❤️ <strong>${stats.likes || 0}</strong></div>
            <div>🔄 <strong>${stats.retweets || 0}</strong></div>
            <div>💬 <strong>${stats.replies || 0}</strong></div>
            <div>💬 <strong>${stats.quotes || 0}</strong></div>
          </div>

          <div class="ad-footer" style="margin-top: 10px;">
            <span style="font-size: 0.75rem; color: #94a3b8;">X (Twitter)</span>
            <a href="${tw.link}" target="_blank" rel="noopener noreferrer" class="btn-meta" style="background: #1d9bf0;">
              Ver en X
            </a>
          </div>
        </div>
      `;
    });
  }

  // 4. SECCIÓN: Publicaciones en Bluesky (AT Protocol)
  if (blueskyPosts.length > 0) {
    html += `
      <div class="section-title-container" style="margin-top: 20px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 10px; height: 10px; background-color: #0285ff; border-radius: 50%;"></span>
          <h3 style="font-size: 0.95rem; font-weight: 700; color: #0f172a;">Publicaciones en Bluesky (${blueskyPosts.length})</h3>
        </div>
        <span style="font-size: 0.75rem; color: #0285ff; font-weight: 600;">🦋 Red Descentralizada</span>
      </div>
    `;

    blueskyPosts.forEach((bp) => {
      const author = bp.author || {};
      const stats = bp.stats || {};
      const dateFormatted = bp.date ? String(bp.date).split('T')[0] : '';

      html += `
        <div class="ad-card" style="border-left: 4px solid #0285ff;">
          <div class="ad-card-header" style="margin-bottom: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="font-weight: 700; font-size: 0.9rem; color: #0f172a;">${escaparHtml(author.name || 'Usuario Bluesky')}</div>
              <div style="font-size: 0.8rem; color: #64748b;">${escaparHtml(author.handle || '')}</div>
            </div>
            <span style="font-size: 0.75rem; color: #94a3b8;">${escaparHtml(dateFormatted)}</span>
          </div>

          <div class="ad-body" style="font-size: 0.875rem; color: #1e293b; line-height: 1.45; margin-bottom: 12px;">
            ${escaparHtml(bp.text)}
          </div>

          <div class="ad-meta-grid">
            <div>❤️ <strong>${stats.likes || 0}</strong></div>
            <div>🔄 <strong>${stats.reposts || 0}</strong></div>
            <div>💬 <strong>${stats.replies || 0}</strong></div>
            <div>💬 <strong>${stats.quotes || 0}</strong></div>
          </div>

          <div class="ad-footer" style="margin-top: 10px;">
            <span style="font-size: 0.75rem; color: #0285ff; font-weight: 600;">🦋 Bluesky</span>
            <a href="${bp.link}" target="_blank" rel="noopener noreferrer" class="btn-meta" style="background: #0285ff;">
              Ver en Bluesky
            </a>
          </div>
        </div>
      `;
    });
  }

  // 5. SECCIÓN: Anuncios Políticos en Meta (Facebook / Instagram Ad Library)
  if (metaAds.length > 0) {
    html += `
      <div class="section-title-container" style="margin-top: 20px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 10px; height: 10px; background-color: #1877f2; border-radius: 50%;"></span>
          <h3 style="font-size: 0.95rem; font-weight: 700; color: #0f172a;">Anuncios de Meta / Facebook (${metaAds.length})</h3>
        </div>
        <span style="font-size: 0.75rem; color: #1877f2; font-weight: 600;">📢 Meta Ad Library</span>
      </div>
    `;

    metaAds.forEach((ad) => {
      const pageName = ad.page_name || "Página Meta";
      const dateFormatted = ad.date || "";

      html += `
        <div class="ad-card" style="border-left: 4px solid #1877f2;">
          <div class="ad-card-header" style="margin-bottom: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="font-weight: 700; font-size: 0.9rem; color: #0f172a;">${escaparHtml(pageName)}</div>
              <span class="ad-reach-badge" style="background: #e7f3ff; color: #1877f2; border: 1px solid #b8daff; font-weight: 600;">Anuncio Electoral</span>
            </div>
            <span style="font-size: 0.75rem; color: #94a3b8;">${escaparHtml(dateFormatted)}</span>
          </div>

          <div class="ad-body" style="font-size: 0.875rem; color: #1e293b; line-height: 1.45; margin-bottom: 12px;">
            ${escaparHtml(ad.text)}
          </div>

          <div class="ad-footer" style="margin-top: 10px;">
            <span style="font-size: 0.75rem; color: #1877f2; font-weight: 600;">📢 Meta Ads</span>
            <a href="${ad.link}" target="_blank" rel="noopener noreferrer" class="btn-meta" style="background: #1877f2;">
              Ver Anuncio en Meta
            </a>
          </div>
        </div>
      `;
    });
  }

  sidebarContent.innerHTML = html;
}

/**
 * Renderiza los Gráficos Interactivos de Chart.js para el Dashboard
 */
async function inicializarChartsDashboard() {
  if (typeof Chart === "undefined") {
    console.error("Chart.js no está cargado.");
    return;
  }

  state.chartsInicializados = true;

  try {
    const res = await fetch(`${state.backendUrl}/api/dashboard/stats`);
    const statsData = res.ok ? await res.json() : null;

    renderizarChartFuentes(statsData);
    renderizarChartProvincias(statsData);
    renderizarChartAdvertencias(statsData);

  } catch (error) {
    console.warn("No se pudo cargar estadísticas del backend, usando datos locales:", error);
    renderizarChartFuentes(null);
    renderizarChartProvincias(null);
    renderizarChartAdvertencias(null);
  }
}

function renderizarChartFuentes(data) {
  const ctx = document.getElementById("chartFuentes");
  if (!ctx) return;

  const fuentes = data?.distribucion_fuentes || { prensa_tiempo_real: 35, fact_checks: 20, redes_sociales_x: 20, bluesky_feed: 15, meta_ads: 10 };

  state.charts.fuentes = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Prensa en Tiempo Real", "Google Fact Check", "Redes Sociales (X)", "Bluesky (AT Protocol)", "Meta Ad Library"],
      datasets: [{
        data: [
          fuentes.prensa_tiempo_real || 35, 
          fuentes.fact_checks || 20, 
          fuentes.redes_sociales_x || 20,
          fuentes.bluesky_feed || 15,
          fuentes.meta_ads || 10
        ],
        backgroundColor: ["#4f46e5", "#ef4444", "#1d9bf0", "#0285ff", "#1877f2"],
        borderWidth: 2,
        borderColor: "#ffffff"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" }
      }
    }
  });
}

function renderizarChartProvincias(data) {
  const ctx = document.getElementById("chartProvincias");
  if (!ctx) return;

  const list = data?.top_provincias_cobertura || [
    { provincia: "Pichincha", porcentaje: 28.4 },
    { provincia: "Guayas", porcentaje: 25.6 },
    { provincia: "Manabí", porcentaje: 15.0 },
    { provincia: "Azuay", porcentaje: 12.4 },
    { provincia: "El Oro", porcentaje: 9.6 },
    { provincia: "Otras Provincias", porcentaje: 9.0 }
  ];

  const labels = list.map(item => item.provincia);
  const values = list.map(item => item.porcentaje);

  state.charts.provincias = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [{
        label: "% de Cobertura Electoral",
        data: values,
        backgroundColor: "#06b6d4",
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { beginAtZero: true, max: 35 }
      }
    }
  });
}

function renderizarChartAdvertencias(data) {
  const ctx = document.getElementById("chartAdvertencias");
  if (!ctx) return;

  const adv = data?.porcentaje_advertencias || { informacion_general: 82, con_advertencia_google: 18 };

  state.charts.advertencias = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Información General / Verificada (82%)", "Contenido con Advertencia (18%)"],
      datasets: [{
        data: [adv.informacion_general, adv.con_advertencia_google],
        backgroundColor: ["#10b981", "#ef4444"],
        borderWidth: 2,
        borderColor: "#ffffff"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" }
      }
    }
  });
}

function escaparHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
