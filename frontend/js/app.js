/**
 * NoAIVerdad - Frontend Logic (Leaflet.js + Marcadores Minimalistas "province-dot" + Tooltips Nativos)
 * Plataforma Cívica para Monitoreo Electoral en Ecuador.
 */

// Estado global de la aplicación
const state = {
  map: null,
  marcadores: {},
  provinciaSeleccionada: null,
  backendUrl: 'http://localhost:8000'
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
}

/**
 * 2. Iteración de marcadores en el mapa usando L.divIcon, iconAnchor [7, 7] y Tooltip nativo
 */
function crearMarcadoresProvincia() {
  provinciasEcuador.forEach((provincia) => {
    // Crear el marcador circular con L.divIcon
    const icon = L.divIcon({
      className: "province-dot-marker-wrapper",
      html: `<div class="province-dot" id="dot-${provincia.id}"></div>`,
      iconSize: [14, 14],      // Tamaño del punto
      iconAnchor: [7, 7]       // Esto centra el punto matemáticamente [mitadX, mitadY]
    });

    // Colocar el marcador
    const marker = L.marker([provincia.lat, provincia.lng], { icon: icon }).addTo(state.map);

    // Añadir el Tooltip nativo
    marker.bindTooltip(`<b>${provincia.nombre}</b>`, {
      direction: "top",
      offset: [0, -10],        // Lo sube un poquito para no tapar el punto
      className: "custom-province-tooltip"
    });

    // Guardar referencia en el estado
    state.marcadores[provincia.nombre] = { marker, data: provincia, id: provincia.id };

    // Evento al hacer clic
    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      seleccionarProvincia(provincia);
    });
  });

  console.log(`Renderizados ${provinciasEcuador.length} marcadores tipo 'province-dot' para Ecuador.`);
}

/**
 * Lógica al seleccionar una provincia (flyTo a las coordenadas centrales y carga del backend)
 */
function seleccionarProvincia(provincia) {
  console.log(`Cargando noticias de ${provincia.nombre}...`);

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

  // Petición al backend
  cargarNoticiasBackend(provincia.nombre);
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

/**
 * Petición fetch al backend para obtener las noticias por provincia
 */
async function cargarNoticiasBackend(provincia) {
  const sidebarContent = document.getElementById("sidebar-content");

  sidebarContent.innerHTML = `
    <div class="state-box">
      <div class="spinner"></div>
      <div class="state-title">Cargando información...</div>
      <div class="state-desc">Consultando publicaciones detectadas en <strong>${provincia}</strong>.</div>
    </div>
  `;

  try {
    const endpoint = `${state.backendUrl}/api/noticias?provincia=${encodeURIComponent(provincia)}`;
    const response = await fetch(endpoint);

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const data = await response.json();
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
 * Renderiza los resultados divididos en "Verificaciones (Fact-Checking)" y "Noticias en Tiempo Real"
 * @param {Object} data JSON con 'provincia', 'tiempo_real' y 'verificaciones'
 */
function renderizarResultados(data) {
  const sidebarContent = document.getElementById("sidebar-content");
  const noticias = data.tiempo_real || [];
  const verificaciones = data.verificaciones || [];

  if (noticias.length === 0 && verificaciones.length === 0) {
    sidebarContent.innerHTML = `
      <div class="state-box">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"/>
        </svg>
        <div class="state-title">Sin registros para ${data.provincia}</div>
        <div class="state-desc">No se encontraron noticias ni verificaciones recientes para esta provincia.</div>
      </div>
    `;
    return;
  }

  let html = "";

  // 1. SECCIÓN A: Verificaciones de Desinformación (Google Fact Check)
  if (verificaciones.length > 0) {
    html += `
      <div class="section-title-container" style="margin-bottom: 10px; display: flex; align-items: center; gap: 8px;">
        <span style="display: inline-block; width: 10px; height: 10px; background-color: #ef4444; border-radius: 50%;"></span>
        <h3 style="font-size: 0.95rem; font-weight: 700; color: #0f172a;">Verificaciones de Desinformación (${verificaciones.length})</h3>
      </div>
    `;

    verificaciones.forEach((v) => {
      const rating = v.textualRating || "No verificado";
      const ratingClass = (rating.toLowerCase().includes("fals") || rating.toLowerCase().includes("engaño")) 
        ? "badge-danger" 
        : "badge-warning";

      html += `
        <div class="ad-card" style="border-left: 4px solid #ef4444;">
          <div class="ad-card-header">
            <div class="ad-page-name" style="font-size: 0.85rem; color: #475569;">
              Afirma: <strong>${escaparHtml(v.claimant)}</strong>
            </div>
            <span class="ad-reach-badge ${ratingClass}">${escaparHtml(rating)}</span>
          </div>

          <div class="ad-title" style="color: #0f172a; font-size: 0.925rem; margin-bottom: 10px;">
            "${escaparHtml(v.text)}"
          </div>

          <div class="ad-footer">
            <span style="font-size: 0.75rem; color: #64748b;">
              Verificado por: <strong>${escaparHtml(v.publisher)}</strong>
            </span>
            <a href="${v.url}" target="_blank" rel="noopener noreferrer" class="btn-meta" style="background: #ef4444;">
              Ver Fact-Check
            </a>
          </div>
        </div>
      `;
    });
  }

  // 2. SECCIÓN B: Noticias en Tiempo Real (GNews API)
  if (noticias.length > 0) {
    html += `
      <div class="section-title-container" style="margin-top: 20px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px;">
        <span style="display: inline-block; width: 10px; height: 10px; background-color: #4f46e5; border-radius: 50%;"></span>
        <h3 style="font-size: 0.95rem; font-weight: 700; color: #0f172a;">Noticias en Tiempo Real (${noticias.length})</h3>
      </div>
    `;

    noticias.forEach((n) => {
      const fechaFormatted = n.fecha ? new Date(n.fecha).toLocaleDateString('es-EC', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

      html += `
        <div class="ad-card">
          <div class="ad-card-header">
            <div class="ad-page-name">${escaparHtml(n.fuente)}</div>
            <span style="font-size: 0.75rem; color: #94a3b8;">${fechaFormatted}</span>
          </div>

          <div class="ad-title" style="color: #1e293b; font-weight: 600;">
            ${escaparHtml(n.titulo)}
          </div>

          <div class="ad-footer" style="margin-top: 12px;">
            <span style="font-size: 0.75rem; color: #64748b;">GNews API</span>
            <a href="${n.url}" target="_blank" rel="noopener noreferrer" class="btn-meta">
              Leer Noticia
            </a>
          </div>
        </div>
      `;
    });
  }

  sidebarContent.innerHTML = html;
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
