/**
 * NoAIVerdad - Frontend Logic (Leaflet.js + Hero Search + Dashboard Chart.js)
 * Plataforma Cívica para Monitoreo Electoral en Ecuador.
 */

// Estado global de la aplicación
const state = {
  map: null,
  marcadores: {},
  provinciaSeleccionada: null,
  chartsInicializados: false,
  charts: {},
  datosActuales: null,       // Último feed leído desde Firebase
  filtroSeccion: "noticias", // 'noticias' | 'verificaciones' | 'tweets' | 'bluesky'
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
  initThemeSwitcher();
  initMap();
  initNavListeners();
  initSearchListeners();
  initFilterListeners();
  // firebase-sync.js inicializa Auth al cargar; no registrar los listeners dos veces.
});

/**
 * Sistema de Switcher de Tema (Claro / Oscuro) y Cambio Dinámico de Logo
 */
function initThemeSwitcher() {
  const btnTheme = document.getElementById("btn-toggle-theme");
  
  // Obtener tema guardado o usar oscuro por defecto
  const savedTheme = localStorage.getItem("noai_theme") || "dark";
  aplicarTema(savedTheme);

  if (btnTheme) {
    btnTheme.addEventListener("click", () => {
      const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
      const newTheme = currentTheme === "dark" ? "light" : "dark";
      aplicarTema(newTheme);
    });
  }
}

function aplicarTema(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("noai_theme", theme);

  const btnTheme = document.getElementById("btn-toggle-theme");
  const logoImg = document.getElementById("brand-logo-img");

  if (theme === "light") {
    if (logoImg) logoImg.src = "img/LOGO_BLACK.png";
    if (btnTheme) btnTheme.innerHTML = "☀️ Modo Claro";
  } else {
    if (logoImg) logoImg.src = "img/LOGO_WHITE.png";
    if (btnTheme) btnTheme.innerHTML = "🌙 Modo Oscuro";
  }
}

/**
 * Inicializa Leaflet.js centrado en Ecuador
 */
function initMap() {
  console.log("Inicializando mapa de Ecuador con marcadores tipo province-dot...");

  // Bounding box que encierra todo Ecuador (incluyendo Galápagos al oeste)
  // SW: (-5.1, -92.1)  NE: (1.7, -75.2)
  const ecuadorBounds = L.latLngBounds(
    L.latLng(-5.1, -92.1),
    L.latLng(1.7, -75.2)
  );

  // Configurar mapa centrado en Ecuador (-1.8312, -78.1834) zoom nivel 7
  state.map = L.map("map", {
    center: [-1.8312, -78.1834],
    zoom: 7,
    minZoom: 6,              // No se puede alejar más allá de donde Ecuador llena la vista
    maxBounds: ecuadorBounds,
    maxBoundsViscosity: 1.0  // El mapa rebota al llegar al borde — no se puede salir
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
  if (document.getElementById("view-dashboard")) document.getElementById("view-dashboard").hidden = true;
  document.getElementById("view-acerca")?.classList.remove("active");
  if (document.getElementById("view-acerca")) document.getElementById("view-acerca").hidden = true;
  document.getElementById("nav-btn-dashboard")?.classList.remove("active");
  document.getElementById("nav-btn-acerca")?.classList.remove("active");
  const viewMapa = document.getElementById("view-mapa");
  if (viewMapa) { viewMapa.hidden = false; viewMapa.classList.add("active"); }

  // Recalcular dimensiones del mapa Leaflet
  setTimeout(() => {
    if (state.map) {
      state.map.invalidateSize();
    }
  }, 400);
}

/**
 * Alterna (abre/cierra) suavemente la sección del Hero Banner al hacer clic
 */
function alternarHero() {
  const heroBanner = document.querySelector(".hero-banner");
  if (!heroBanner) return;

  const estaColapsado = heroBanner.classList.contains("collapsed");

  if (estaColapsado) {
    expandirHero();
    setTimeout(() => {
      const selectProvincia = document.getElementById("hero-province-select");
      if (selectProvincia) {
        selectProvincia.focus();
        selectProvincia.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 150);
  } else {
    colapsarHero();
  }
}

/**
 * EventListeners para la Navegación por Pestañas y Marca
 */
function initNavListeners() {
  const btnDashboard = document.getElementById("nav-btn-dashboard");
  const btnAcerca = document.getElementById("nav-btn-acerca");
  const btnReopenHero = document.getElementById("btn-reopen-hero");
  const viewMapa = document.getElementById("view-mapa");
  const viewDashboard = document.getElementById("view-dashboard");
  const viewAcerca = document.getElementById("view-acerca");
  const brandLogo = document.querySelector(".brand-container");

  // Helper: activar una pestaña y desactivar las demás
  const activarVista = (vistaActiva) => {
    [viewMapa, viewDashboard, viewAcerca].forEach(v => {
      if (!v) return;
      const activa = v === vistaActiva;
      v.hidden = !activa;
      v.classList.toggle("active", activa);
    });
    [btnDashboard, btnAcerca].forEach(b => b?.classList.remove("active"));
    if (vistaActiva === viewMapa) {
      setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 400);
    }
  };

  if (brandLogo) {
    brandLogo.addEventListener("click", alternarHero);
  }

  if (btnReopenHero) {
    btnReopenHero.addEventListener("click", alternarHero);
  }

  if (btnDashboard) {
    btnDashboard.addEventListener("click", () => {
      const estaActivo = viewDashboard?.classList.contains("active");
      if (estaActivo) {
        activarVista(viewMapa);
        expandirHero();
      } else {
        btnDashboard.classList.add("active");
        activarVista(viewDashboard);
        if (!state.chartsInicializados) {
          inicializarChartsDashboard();
        }
      }
    });
  }

  if (btnAcerca) {
    btnAcerca.addEventListener("click", () => {
      const estaActivo = viewAcerca?.classList.contains("active");
      if (estaActivo) {
        activarVista(viewMapa);
        expandirHero();
      } else {
        btnAcerca.classList.add("active");
        activarVista(viewAcerca);
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
      if (document.getElementById("view-dashboard")) document.getElementById("view-dashboard").hidden = true;
      document.getElementById("view-acerca")?.classList.remove("active");
      if (document.getElementById("view-acerca")) document.getElementById("view-acerca").hidden = true;
      document.getElementById("nav-btn-dashboard")?.classList.remove("active");
      document.getElementById("nav-btn-acerca")?.classList.remove("active");
      const viewMapa = document.getElementById("view-mapa");
      if (viewMapa) { viewMapa.hidden = false; viewMapa.classList.add("active"); }

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
        cargarNoticiasAlmacenadas(state.provinciaSeleccionada, state.filtroSeccion);
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
 * Lógica al seleccionar una provincia (flyTo y lectura del feed almacenado en Firebase)
 */
function seleccionarProvincia(provincia) {
  console.log(`Cargando noticias de ${provincia.nombre}...`);

  // Elegir una provincia siempre vuelve al mapa y desactiva las demás vistas.
  document.getElementById("view-dashboard")?.classList.remove("active");
  if (document.getElementById("view-dashboard")) document.getElementById("view-dashboard").hidden = true;
  document.getElementById("nav-btn-dashboard")?.classList.remove("active");
  document.getElementById("view-acerca")?.classList.remove("active");
  if (document.getElementById("view-acerca")) document.getElementById("view-acerca").hidden = true;
  document.getElementById("nav-btn-acerca")?.classList.remove("active");
  const viewMapa = document.getElementById("view-mapa");
  if (viewMapa) { viewMapa.hidden = false; viewMapa.classList.add("active"); }

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

  // Recalcular el mapa después de reactivar su vista (por ejemplo, desde Acerca de).
  setTimeout(() => {
    if (!state.map) return;
    state.map.invalidateSize();
    state.map.flyTo([provincia.lat, provincia.lng], 9, {
      animate: true,
      duration: 1.2
    });
  }, 100);

  // Actualizar la interfaz del panel lateral
  actualizarSidebar(provincia.nombre);

  cargarNoticiasAlmacenadas(provincia.nombre, state.filtroSeccion);
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

/** Lee únicamente las noticias que el colector del backend ya guardó en Firebase. */
async function cargarNoticiasAlmacenadas(provincia, seccion = state.filtroSeccion) {
  const sidebarContent = document.getElementById("sidebar-content");
  state.filtroSeccion = seccion;

  // Inicializar cache para la provincia si no existe
  if (!state.feedCache[provincia]) {
    state.feedCache[provincia] = {};
  }

  // Si la sección ya fue descargada en memoria, cargar de inmediato
  const cached = state.feedCache[provincia]?.[seccion];
  if (cached && (
      (cached.tiempo_real && cached.tiempo_real.length > 0) ||
      (cached.verificaciones && cached.verificaciones.length > 0) ||
      (cached.tweets_recientes && cached.tweets_recientes.length > 0) ||
      (cached.bluesky_posts && cached.bluesky_posts.length > 0) ||
      (cached.bluesky_posts_nacionales && cached.bluesky_posts_nacionales.length > 0)
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
      <div class="state-desc">Leyendo los datos guardados de <strong>${escaparHtml(provincia)}</strong> en Firebase.</div>
    </div>
  `;

  // 1. Intentar consultar primero en Firebase Realtime Database
  if (window.NoAIFirebaseSync) {
    try {
      const fbData = await window.NoAIFirebaseSync.consultarNoticiasFirebase(provincia);
      const seccionFirebase = {
        noticias: "tiempo_real", verificaciones: "verificaciones", tweets: "tweets_recientes",
        bluesky: "bluesky_posts"
      }[seccion];
      const tieneDatos = fbData && seccionFirebase && (
        (Array.isArray(fbData[seccionFirebase]) && fbData[seccionFirebase].length > 0) ||
        (seccion === "bluesky" && Array.isArray(fbData.bluesky_posts_nacionales) && fbData.bluesky_posts_nacionales.length > 0)
      );
      if (tieneDatos) {
        console.log(`[Firebase Realtime DB] Datos obtenidos de la base de datos para: ${provincia}`);
        state.feedCache[provincia][seccion] = fbData;
        state.datosActuales = fbData;
        renderizarResultados(fbData);
        return;
      }
    } catch (fbErr) {
      console.warn("[Firebase Realtime DB] Error al consultar Realtime DB:", fbErr);
    }
  }

  state.datosActuales = null;
  sidebarContent.innerHTML = `
    <div class="state-box">
      <div class="state-title">Aún no hay datos guardados</div>
      <div class="state-desc">El colector del servidor debe consultar las fuentes y guardar sus resultados en Firebase. Esta aplicación solo muestra los datos almacenados.</div>
    </div>
  `;
}

/**
 * Helpers para el filtrado por año
 */
function obtenerAnioItem(item) {
  const textDate = item.date || item.fecha || item.date_created || item.pubDate || item.anio || "";
  const match = String(textDate).match(/\b(202[0-9])\b/);
  if (match) return match[1];
  if (item.anio) return String(item.anio);
  return "";
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
 * Renderiza el feed unificado en tiempo real con filtrado por Sección y Año (Prensa, Fact-Check, X y Bluesky)
 */
function renderizarResultados(data) {
  const sidebarContent = document.getElementById("sidebar-content");
  const seccion = state.filtroSeccion;
  const anio = state.filtroAnio;

  const rawNoticias = data.tiempo_real || [];
  const rawVerificaciones = data.verificaciones || [];
  // X está desactivado y no debe aparecer ni desde caché antigua de Firebase.
  const rawTweets = [];
  const rawBluesky = data.bluesky_posts || [];
  const rawBlueskyNacionales = data.bluesky_posts_nacionales || [];

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

  const blueskyNationalPosts = (seccion === "todas" || seccion === "bluesky")
    ? rawBlueskyNacionales.filter(item => itemCumpleAnio(item, anio))
    : [];

  const totalElementos = noticias.length + verificaciones.length + tweets.length + blueskyPosts.length + blueskyNationalPosts.length;

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
          <h3 style="font-size: 0.95rem; font-weight: 700;">Noticias en Tiempo Real (${noticias.length})</h3>
        </div>
        <span style="font-size: 0.75rem; color: #64748b;">Prensa Ecuador</span>
      </div>
    `;

    noticias.forEach((n) => {
      const fechaFormatted = formatearFechaSafe(n.fecha);

      html += `
        <div class="item-card" style="border-left: 4px solid #4f46e5;">
          <div class="item-card-header">
            <div class="item-page-name">${escaparHtml(n.fuente)}</div>
            <span style="font-size: 0.75rem; color: #94a3b8;">${fechaFormatted}</span>
          </div>

          <div class="item-title" style="font-weight: 600;">
            ${escaparHtml(n.titulo)}
          </div>

          <div class="item-footer" style="margin-top: 12px;">
            <span style="font-size: 0.75rem; color: #64748b;">Noticia</span>
            <a href="${n.url}" target="_blank" rel="noopener noreferrer" class="btn-action">
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
          <h3 style="font-size: 0.95rem; font-weight: 700;">Fact-Checking / Verificaciones (${verificaciones.length})</h3>
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
        <div class="item-card" style="border-left: 4px solid ${esFalso ? '#ef4444' : '#06b6d4'};">
          <div class="item-card-header">
            <div class="item-page-name" style="font-size: 0.85rem;">
              Afirma: <strong>${escaparHtml(v.claimant)}</strong>
            </div>
            <span class="item-reach-badge" style="background: ${esFalso ? '#fef2f2' : '#e0f2fe'}; color: ${esFalso ? '#991b1b' : '#0369a1'}; border: 1px solid ${esFalso ? '#fecaca' : '#bae6fd'}; font-weight: 600;">
              ${esFalso ? '⚠️ Advertencia' : 'Fact-Check'}
            </span>
          </div>

          <div class="item-title" style="font-size: 0.925rem; margin-bottom: 8px;">
            "${escaparHtml(v.text)}"
          </div>

          ${warningHtml}

          <div class="item-footer">
            <span style="font-size: 0.75rem; color: #64748b;">
              Fuente: <strong>${escaparHtml(v.publisher)}</strong>
            </span>
            <a href="${v.url}" target="_blank" rel="noopener noreferrer" class="btn-action" style="background: ${esFalso ? '#dc2626' : '#0284c7'};">
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
          <h3 style="font-size: 0.95rem; font-weight: 700;">Publicaciones en X / Twitter (${tweets.length})</h3>
        </div>
        <span style="font-size: 0.75rem; color: #1d9bf0; font-weight: 600;">Redes Sociales</span>
      </div>
    `;

    tweets.forEach((tw) => {
      const user = tw.user || {};
      const stats = tw.stats || {};

      html += `
        <div class="item-card" style="border-left: 4px solid #1d9bf0;">
          <div class="item-card-header" style="margin-bottom: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div class="item-page-name" style="font-weight: 700; font-size: 0.9rem;">${escaparHtml(user.name || 'Usuario X')}</div>
              <div style="font-size: 0.8rem; color: #64748b;">${escaparHtml(user.username || '')}</div>
            </div>
            <span style="font-size: 0.75rem; color: #94a3b8;">${escaparHtml(tw.date || '')}</span>
          </div>

          <div class="item-body" style="font-size: 0.875rem; line-height: 1.45; margin-bottom: 12px;">
            ${escaparHtml(tw.text)}
          </div>

          <div class="item-meta-grid">
            <div>❤️ <strong>${stats.likes || 0}</strong></div>
            <div>🔄 <strong>${stats.retweets || 0}</strong></div>
            <div>💬 <strong>${stats.replies || 0}</strong></div>
            <div>💬 <strong>${stats.quotes || 0}</strong></div>
          </div>

          <div class="item-footer" style="margin-top: 10px;">
            <span style="font-size: 0.75rem; color: #94a3b8;">X (Twitter)</span>
            <a href="${tw.link}" target="_blank" rel="noopener noreferrer" class="btn-action" style="background: #1d9bf0;">
              Ver en X
            </a>
          </div>
        </div>
      `;
    });
  }

  // 4. SECCIÓN: Publicaciones en Bluesky (AT Protocol)
  if (blueskyPosts.length > 0 || blueskyNationalPosts.length > 0) {
    html += `
      <div class="section-title-container" style="margin-top: 20px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 10px; height: 10px; background-color: #0285ff; border-radius: 50%;"></span>
          <h3 style="font-size: 0.95rem; font-weight: 700;">Publicaciones electorales locales en Bluesky (${blueskyPosts.length})</h3>
        </div>
        <span style="font-size: 0.75rem; color: #0285ff; font-weight: 600;">🦋 Red Descentralizada</span>
      </div>
    `;

    blueskyPosts.forEach((bp) => {
      const author = bp.author || {};
      const stats = bp.stats || {};
      const dateFormatted = bp.date ? String(bp.date).split('T')[0] : '';

      html += `
        <div class="item-card" style="border-left: 4px solid #0285ff;">
          <div class="item-card-header" style="margin-bottom: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div class="item-page-name" style="font-weight: 700; font-size: 0.9rem;">${escaparHtml(author.name || 'Usuario Bluesky')}</div>
              <div style="font-size: 0.8rem; color: #64748b;">${escaparHtml(author.handle || '')}</div>
            </div>
            <span style="font-size: 0.75rem; color: #94a3b8;">${escaparHtml(dateFormatted)}</span>
          </div>

          <div class="item-body" style="font-size: 0.875rem; line-height: 1.45; margin-bottom: 12px;">
            ${escaparHtml(bp.text)}
          </div>

          <div class="item-meta-grid">
            <div>❤️ <strong>${stats.likes || 0}</strong></div>
            <div>🔄 <strong>${stats.reposts || 0}</strong></div>
            <div>💬 <strong>${stats.replies || 0}</strong></div>
            <div>💬 <strong>${stats.quotes || 0}</strong></div>
          </div>

          <div class="item-footer" style="margin-top: 10px;">
            <span style="font-size: 0.75rem; color: #0285ff; font-weight: 600;">🦋 Bluesky</span>
            <a href="${bp.link}" target="_blank" rel="noopener noreferrer" class="btn-action" style="background: #0285ff;">
              Ver en Bluesky
            </a>
          </div>
        </div>
      `;
    });

    if (blueskyNationalPosts.length > 0) {
      html += `
        <details style="margin: 14px 0; border: 1px solid #334155; border-radius: 10px; padding: 10px 12px;">
          <summary style="cursor: pointer; font-weight: 700; color: #94a3b8;">
            Archivo anterior de búsqueda amplia (${blueskyNationalPosts.length}) — abrir para consultar
          </summary>
          <p style="font-size: 0.8rem; color: #94a3b8; margin: 8px 0;">Se conserva separado; la búsqueda anterior era amplia y algunas publicaciones pueden no tratar de elecciones ni de esta provincia.</p>
      `;
      blueskyNationalPosts.forEach((bp) => {
        const author = bp.author || {};
        html += `
          <div class="item-card" style="border-left: 4px solid #64748b;">
            <div class="item-card-header">
              <strong>${escaparHtml(author.name || 'Usuario Bluesky')}</strong>
              <span style="color:#64748b;">${escaparHtml(author.handle || '')}</span>
            </div>
            <div class="item-body">${escaparHtml(bp.text || '')}</div>
            <a href="${escaparHtml(bp.link || '#')}" target="_blank" rel="noopener noreferrer" class="btn-action" style="background:#64748b;">Ver en Bluesky</a>
          </div>
        `;
      });
      html += `</details>`;
    }
  }

  sidebarContent.innerHTML = html;
}

/**
 * Renderiza los Gráficos Interactivos de Chart.js para el Dashboard
 */
/**
 * Renderiza los Gráficos Interactivos de Chart.js para el Dashboard con filtro por provincia y resumen general en vivo
 */
async function inicializarChartsDashboard() {
  if (typeof Chart === "undefined") {
    console.error("Chart.js no está cargado.");
    return;
  }

  // Vincular eventos del selector y botón de actualización si no están vinculados
  if (!state.dashboardListenersInicializados) {
    state.dashboardListenersInicializados = true;
    
    const dashSelect = document.getElementById("dashboard-province-select");
    const btnRefresh = document.getElementById("btn-refresh-dashboard");

    if (dashSelect) {
      dashSelect.addEventListener("change", (e) => {
        cargarEstadisticasDashboard(e.target.value);
      });
    }

    if (btnRefresh) {
      btnRefresh.addEventListener("click", () => {
        const provVal = dashSelect ? dashSelect.value : "todas";
        cargarEstadisticasDashboard(provVal);
      });
    }
  }

  const dashSelect = document.getElementById("dashboard-province-select");
  const provInicial = dashSelect ? dashSelect.value : "todas";

  inicializarBuscadorPalabrasClave();
  await cargarEstadisticasDashboard(provInicial);
}

async function cargarEstadisticasDashboard(provincia = "todas") {
  state.chartsInicializados = true;
  const loadingOverlay = document.getElementById("dashboard-loading");
  const cardProvincias = document.getElementById("card-chart-provincias");

  if (loadingOverlay) loadingOverlay.style.display = "flex";

  // Mostrar u ocultar el gráfico de Provincias con Mayor Cobertura según el filtro
  if (cardProvincias) {
    cardProvincias.style.display = (provincia === "todas" || !provincia) ? "block" : "none";
  }

  // Las estadísticas las escribe el colector del servidor; el frontend solo lee.
  if (window.NoAIFirebaseSync) {
    try {
      const fbStats = await window.NoAIFirebaseSync.consultarDashboardStatsFirebase();
      if (fbStats && fbStats.distribucion_fuentes) {
        console.log("[Dashboard Stats] Cargadas desde Firebase Realtime Database");
        actualizarResumenYSincronizacion(fbStats, provincia);
        renderizarChartFuentes(fbStats);
        renderizarChartProvincias(fbStats);
        if (loadingOverlay) loadingOverlay.style.display = "none";
        return;
      }
    } catch (fbErr) {
      console.warn("[Dashboard Stats] Error leyendo de Firebase RTDB:", fbErr);
    }
  }
  actualizarResumenYSincronizacion(null, provincia);
  renderizarChartFuentes(null);
  renderizarChartProvincias(null);
  const summary = document.getElementById("summary-content");
  if (summary) summary.textContent = "Las estadísticas aparecerán cuando el colector del servidor las guarde en Firebase.";
  if (loadingOverlay) {
    setTimeout(() => { loadingOverlay.style.display = "none"; }, 250);
  }
}

function actualizarResumenYSincronizacion(data, provincia) {
  const summaryContent = document.getElementById("summary-content");
  const summaryScopeBadge = document.getElementById("summary-scope-badge");
  const liveUpdateText = document.getElementById("live-update-text");
  const metricFactChecks = document.getElementById("metric-factchecks");

  const updatedAt = data?.actualizado_en ? new Date(data.actualizado_en) : null;
  if (liveUpdateText) {
    liveUpdateText.textContent = updatedAt && !Number.isNaN(updatedAt.getTime())
      ? `Datos actualizados: ${updatedAt.toLocaleString('es-EC')}`
      : "Sin datos guardados";
  }

  const nombreProvincia = (provincia === "todas" || !provincia) ? "Ecuador (Nacional)" : provincia;
  if (summaryScopeBadge) summaryScopeBadge.textContent = nombreProvincia;

  if (data && data.resumen_general) {
    if (summaryContent) summaryContent.innerHTML = data.resumen_general;
    if (metricFactChecks) {
      metricFactChecks.textContent = String(data.distribucion_fuentes?.fact_checks ?? 0);
    }
  } else {
    // Generación de resumen dinámico fallback
    const provName = (provincia === "todas" || !provincia) ? "Ecuador" : provincia;
    if (summaryContent) {
      summaryContent.textContent = `Aún no hay estadísticas guardadas para ${provName}. El servidor las mostrará cuando termine la primera recolección.`;
    }
  }
}

function renderizarChartFuentes(data) {
  const ctx = document.getElementById("chartFuentes");
  if (!ctx) return;

  if (state.charts.fuentes) {
    state.charts.fuentes.destroy();
  }

  const fuentes = data?.distribucion_fuentes || { prensa_tiempo_real: 0, fact_checks: 0, redes_sociales_x: 0, bluesky_feed: 0 };

  state.charts.fuentes = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Prensa (Google News/GNews)", "Revisiones Google Fact Check", "Bluesky"],
      datasets: [{
        data: [
          fuentes.prensa_tiempo_real || 0,
          fuentes.fact_checks || 0,
          fuentes.bluesky_feed || 0
        ],
        backgroundColor: ["#4f46e5", "#ef4444", "#0285ff"],
        borderWidth: 2,
        borderColor: "#ffffff"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { 
          position: "bottom", 
          onClick: () => {}, 
          labels: { color: "#0f172a", font: { family: "Inter", size: 12, weight: "700" } } 
        }
      }
    }
  });
}

function renderizarChartProvincias(data) {
  const ctx = document.getElementById("chartProvincias");
  if (!ctx) return;

  if (state.charts.provincias) {
    state.charts.provincias.destroy();
  }

  const list = data?.top_provincias_cobertura || [];

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
        x: { beginAtZero: true, max: 100, ticks: { color: "#334155", font: { family: "Inter", size: 11, weight: "600" } }, grid: { color: "#e2e8f0" } },
        y: { ticks: { color: "#0f172a", font: { family: "Inter", size: 12, weight: "700" } }, grid: { color: "#e2e8f0" } }
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

/**
 * Inicializa el Buscador de Palabras Clave y Sugerencias Frecuentes en el Dashboard
 */
async function inicializarBuscadorPalabrasClave() {
  const inputKW = document.getElementById("dashboard-keyword-input");
  const btnSearchKW = document.getElementById("btn-search-keyword");
  const pillsList = document.getElementById("keyword-pills-list");

  if (!pillsList) return;

  const savedKeywords = await window.NoAIFirebaseSync?.consultarKeywordsFirebase();
  renderizarPildorasTendencia(savedKeywords?.trending_keywords || []);

  // Escuchar actualizaciones en tiempo real desde Firebase
  if (window.NoAIFirebaseSync) {
    window.NoAIFirebaseSync.escucharKeywordsFirebase((fbData) => {
      if (fbData && fbData.trending_keywords) {
        renderizarPildorasTendencia(fbData.trending_keywords);
      }
    });
  }

  if (btnSearchKW && inputKW) {
    btnSearchKW.addEventListener("click", () => {
      const palabra = inputKW.value.trim();
      if (palabra) consultarAnalisisPalabraClave(palabra);
    });

    inputKW.addEventListener("keyup", (e) => {
      if (e.key === "Enter") {
        const palabra = inputKW.value.trim();
        if (palabra) consultarAnalisisPalabraClave(palabra);
      }
    });
  }
}

function renderizarPildorasTendencia(keywords = []) {
  const pillsList = document.getElementById("keyword-pills-list");
  if (!pillsList) return;

  let html = "";
  keywords.forEach(kw => {
    html += `
      <button class="kw-pill" data-word="${escaparHtml(kw.word)}">
        🔥 #${escaparHtml(kw.word)}
      </button>
    `;
  });
  if (!html) html = '<p class="state-desc">Las tendencias aparecerán cuando el colector las guarde en Firebase.</p>';
  pillsList.innerHTML = html;

  pillsList.querySelectorAll(".kw-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      const word = pill.getAttribute("data-word");
      const inputKW = document.getElementById("dashboard-keyword-input");
      if (inputKW) inputKW.value = word;
      
      pillsList.querySelectorAll(".kw-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");

      consultarAnalisisPalabraClave(word);
    });
  });
}

async function consultarAnalisisPalabraClave(palabra) {
  const resultBox = document.getElementById("keyword-analysis-result");
  if (!resultBox) return;

  resultBox.style.display = "block";
  resultBox.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px; color: #94a3b8; font-size: 0.9rem;">
      <div class="loading-spinner" style="width: 20px; height: 20px; border-width: 2px;"></div>
      Analizando menciones y frecuencia de "<strong>${escaparHtml(palabra)}</strong>"...
    </div>
  `;

  try {
    const snapshot = await window.NoAIFirebase?.db?.ref("noticias").once("value");
    const provincias = snapshot?.val() || {};
    const termino = normalizarTexto(palabra);
    const camposPorSeccion = {
      tiempo_real: ["titulo", "fuente"],
      verificaciones: ["text", "claim", "publisher", "claimant"],
      bluesky_posts: ["text", "titulo", "author"]
    };
    const coincidencias = [];
    const distribucion = { prensa: 0, fact_check: 0, bluesky: 0 };

    Object.values(provincias).forEach((feed) => {
      Object.entries(camposPorSeccion).forEach(([seccion, campos]) => {
        (Array.isArray(feed?.[seccion]) ? feed[seccion] : []).forEach((item) => {
          const texto = campos.map((campo) => item?.[campo] || "").join(" ");
          if (normalizarTexto(texto).includes(termino)) {
            coincidencias.push(item.titulo || item.text || item.claim || texto);
            const categoria = {
              tiempo_real: "prensa", verificaciones: "fact_check",
              bluesky_posts: "bluesky"
            }[seccion];
            distribucion[categoria] += 1;
          }
        });
      });
    });

    const data = {
      analisis: {
        palabra,
        categoria: "Coincidencias en Firebase",
        menciones_totales: coincidencias.length,
        distribucion,
        resumen_analisis: `Se encontraron <strong>${coincidencias.length}</strong> coincidencias en los datos almacenados en Firebase.`,
        titulares_relacionados: coincidencias.slice(0, 5)
      }
    };

    if (data && data.analisis) {
      const a = data.analisis;
      
      let titularesSection = "";
      if (a.titulares_relacionados && a.titulares_relacionados.length > 0) {
        const titularesItems = a.titulares_relacionados.map(t => `<li style="margin-bottom: 4px; color: #cbd5e1;">📰 ${escaparHtml(t)}</li>`).join("");
        titularesSection = `
          <div style="margin-top: 10px;">
            <strong style="font-size: 0.8rem; color: #fbbf24; display: block; margin-bottom: 6px;">Coincidencias en Noticias Recientes:</strong>
            <ul style="padding-left: 18px; margin: 0; font-size: 0.85rem;">
              ${titularesItems}
            </ul>
          </div>
        `;
      } else {
        titularesSection = `
          <div style="margin-top: 10px; font-size: 0.85rem; color: #94a3b8; font-style: italic; background: rgba(255,255,255,0.03); padding: 8px 12px; border-radius: 6px;">
            ℹ️ No se detectaron noticias o publicaciones que contengan exactamente esta palabra clave en la cobertura en vivo.
          </div>
        `;
      }

      resultBox.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; flex-wrap: wrap; gap: 10px;">
          <h4 style="font-size: 1rem; color: #ffffff; margin: 0; font-weight: 700;">
            📊 Análisis de Menciones: <span style="color: #38bdf8;">"${escaparHtml(a.palabra)}"</span>
          </h4>
          <span style="background: rgba(79, 70, 229, 0.2); color: #818cf8; border: 1px solid #6366f1; padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700;">
            Categoría: ${escaparHtml(a.categoria)}
          </span>
        </div>

        <p style="font-size: 0.9rem; color: #cbd5e1; line-height: 1.5; margin-bottom: 12px;">
          ${a.resumen_analisis}
        </p>

        ${titularesSection}
      `;
    }
  } catch (err) {
    resultBox.innerHTML = `<div style="color: #ef4444; font-size: 0.9rem;">No se pudieron leer las noticias almacenadas en Firebase.</div>`;
  }
}

function normalizarTexto(valor) {
  return String(valor || "").toLocaleLowerCase("es")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
