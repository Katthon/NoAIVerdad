/**
 * NoAIVerdad - Firebase Realtime Database & Auth Integration
 * Conexión en tiempo real con Firebase Realtime Database para noticias,
 * métricas provinciales, palabras clave y gestión de sesiones de usuario.
 */

// Normalizar nombre de provincia para usar como clave segura en Firebase Realtime Database
function normalizarClaveFirebase(str) {
  if (!str) return "ecuador_nacional";
  return String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Control del Modal de Autenticación (Crear Cuenta / Iniciar Sesión)
 */
function abrirModalAuth(tab = "register") {
  const modal = document.getElementById("modal-auth-overlay");
  if (!modal) return;

  const tabReg = document.getElementById("modal-tab-register");
  const tabLog = document.getElementById("modal-tab-login");
  const formReg = document.getElementById("modal-form-register");
  const formLog = document.getElementById("modal-form-login");
  const alertBox = document.getElementById("modal-auth-alert");

  if (alertBox) {
    alertBox.style.display = "none";
    alertBox.textContent = "";
  }

  if (tab === "login") {
    tabLog?.classList.add("active");
    tabReg?.classList.remove("active");
    if (formLog) formLog.style.display = "block";
    if (formReg) formReg.style.display = "none";
  } else {
    tabReg?.classList.add("active");
    tabLog?.classList.remove("active");
    if (formReg) formReg.style.display = "block";
    if (formLog) formLog.style.display = "none";
  }

  modal.classList.add("active");
}

function cerrarModalAuth() {
  if (!window.NoAIFirebase?.auth?.currentUser) return;
  const modal = document.getElementById("modal-auth-overlay");
  if (modal) {
    modal.classList.remove("active");
  }
}

function mostrarAlertaAuth(mensaje, tipo = "error") {
  const alertBox = document.getElementById("modal-auth-alert");
  if (!alertBox) return;
  alertBox.className = `auth-modal-alert ${tipo}`;
  alertBox.textContent = mensaje;
  alertBox.style.display = "block";
}

/**
 * Traduce códigos de error comunes de Firebase Auth al español
 */
function traducirErrorAuth(errorCode) {
  switch (errorCode) {
    case "auth/email-already-in-use":
      return "Este correo electrónico ya está registrado. Por favor inicia sesión.";
    case "auth/invalid-email":
      return "El formato del correo electrónico no es válido.";
    case "auth/operation-not-allowed":
      return "La operación no está permitida en este momento.";
    case "auth/weak-password":
      return "La contraseña es muy débil. Debe tener al menos 6 caracteres.";
    case "auth/user-disabled":
      return "Esta cuenta de usuario ha sido inhabilitada.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Credenciales incorrectas. Verifica tu correo y contraseña.";
    case "auth/popup-closed-by-user":
      return "La ventana de inicio de sesión con Google fue cerrada antes de completar el acceso.";
    case "auth/popup-blocked":
      return "El navegador bloqueó la ventana emergente. Permite ventanas emergentes para continuar con Google.";
    case "auth/operation-not-supported-in-this-environment":
      return "Google no puede abrirse desde file:// o si el almacenamiento del navegador está bloqueado. Abre la aplicación desde http://localhost o desde el sitio web publicado y habilita el almacenamiento.";
    case "auth/unauthorized-domain":
      return "Este dominio aún no está autorizado en Firebase. Agrégalo en Authentication > Settings > Authorized domains.";
    default:
      return "Ocurrió un error con el servicio de autenticación. Inténtalo nuevamente.";
  }
}

/**
 * 1. Inicialización de UI y Lógica de Autenticación (Header y Modal)
 */
function initFirebaseAuthUI() {
  const btnLogin = document.getElementById("btn-nav-login");
  const profileBadge = document.getElementById("user-profile-badge");
  const userNameText = document.getElementById("user-display-name");
  const userAvatarInitials = document.getElementById("user-avatar-initials");
  const btnLogout = document.getElementById("btn-nav-logout");

  const modal = document.getElementById("modal-auth-overlay");
  const tabReg = document.getElementById("modal-tab-register");
  const tabLog = document.getElementById("modal-tab-login");
  const formReg = document.getElementById("modal-form-register");
  const formLog = document.getElementById("modal-form-login");
  const btnGoogle = document.getElementById("modal-btn-google");
  const linkForgot = document.getElementById("modal-link-forgot-pass");

  if (!window.NoAIFirebase || !window.NoAIFirebase.auth) {
    console.warn("[Firebase Sync] SDK de Firebase no disponible.");
    return;
  }

  const auth = window.NoAIFirebase.auth;
  const googleProvider = window.NoAIFirebase.googleProvider;

  // Botón del Header abre el modal
  if (btnLogin) {
    btnLogin.addEventListener("click", () => {
      abrirModalAuth("login");
    });
  }

  // El acceso es obligatorio: el clic fuera de la tarjeta no cierra el formulario
  // ni debe activar controles de la interfaz que está detrás del overlay.
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        e.preventDefault();
      }
      e.stopPropagation();
    });
  }

  // Switch de Pestañas
  if (tabReg) {
    tabReg.addEventListener("click", () => abrirModalAuth("register"));
  }
  if (tabLog) {
    tabLog.addEventListener("click", () => abrirModalAuth("login"));
  }

  // Registro con Correo y Contraseña
  if (formReg) {
    formReg.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nombre = document.getElementById("modal-reg-name")?.value.trim();
      const email = document.getElementById("modal-reg-email")?.value.trim();
      const pass = document.getElementById("modal-reg-password")?.value;
      const passConfirm = document.getElementById("modal-reg-password-confirm")?.value;
      const submitBtn = document.getElementById("modal-btn-submit-reg");

      if (pass !== passConfirm) {
        mostrarAlertaAuth("Las contraseñas no coinciden. Por favor verifícalas.", "error");
        return;
      }

      if (pass.length < 6) {
        mostrarAlertaAuth("La contraseña debe tener al menos 6 caracteres.", "error");
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = "<span>Creando cuenta...</span>";
      }

      try {
        const userCredential = await auth.createUserWithEmailAndPassword(email, pass);
        const user = userCredential.user;

        if (nombre && user.updateProfile) {
          await user.updateProfile({ displayName: nombre });
        }

        if (window.NoAIFirebase.sincronizarUsuarioEnDatabase) {
          await window.NoAIFirebase.sincronizarUsuarioEnDatabase(user);
        }

        mostrarAlertaAuth("¡Cuenta creada exitosamente! Bienvenido.", "success");
        setTimeout(() => {
          cerrarModalAuth();
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = "<span>Crear Cuenta Ciudadana</span>";
          }
        }, 800);
      } catch (err) {
        console.error("[Firebase Auth] Error de registro:", err);
        mostrarAlertaAuth(traducirErrorAuth(err.code), "error");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = "<span>Crear Cuenta Ciudadana</span>";
        }
      }
    });
  }

  // Inicio de Sesión con Correo y Contraseña
  if (formLog) {
    formLog.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("modal-login-email")?.value.trim();
      const pass = document.getElementById("modal-login-password")?.value;
      const submitBtn = document.getElementById("modal-btn-submit-login");

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = "<span>Verificando...</span>";
      }

      try {
        const userCredential = await auth.signInWithEmailAndPassword(email, pass);
        const user = userCredential.user;

        if (window.NoAIFirebase.sincronizarUsuarioEnDatabase) {
          await window.NoAIFirebase.sincronizarUsuarioEnDatabase(user);
        }

        mostrarAlertaAuth("¡Sesión iniciada con éxito!", "success");
        setTimeout(() => {
          cerrarModalAuth();
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = "<span>Ingresar a NoAIVerdad</span>";
          }
        }, 600);
      } catch (err) {
        console.error("[Firebase Auth] Error de inicio de sesión:", err);
        mostrarAlertaAuth(traducirErrorAuth(err.code), "error");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = "<span>Ingresar a NoAIVerdad</span>";
        }
      }
    });
  }

  // Inicio de Sesión con Google
  if (btnGoogle) {
    btnGoogle.addEventListener("click", async () => {
      if (!["http:", "https:", "chrome-extension:"].includes(window.location.protocol)) {
        mostrarAlertaAuth("La app se abrió como archivo local (file://). Ejecuta la versión actualizada de NoAIVerdad o ábrela desde http://localhost; Google no funciona al abrir index.html directamente.", "error");
        return;
      }

      try {
        const storageProbe = "__noaiverdad_auth_storage_probe__";
        window.localStorage.setItem(storageProbe, "1");
        window.localStorage.removeItem(storageProbe);
      } catch (storageError) {
        mostrarAlertaAuth("El navegador bloqueó el almacenamiento local. Habilítalo para este sitio y vuelve a intentar Google.", "error");
        return;
      }

      try {
        btnGoogle.disabled = true;
        btnGoogle.style.opacity = "0.7";
        const result = await auth.signInWithPopup(googleProvider);
        const user = result.user;

        if (window.NoAIFirebase.sincronizarUsuarioEnDatabase) {
          await window.NoAIFirebase.sincronizarUsuarioEnDatabase(user);
        }

        mostrarAlertaAuth("¡Autenticación con Google exitosa!", "success");
        setTimeout(() => {
          cerrarModalAuth();
          btnGoogle.disabled = false;
          btnGoogle.style.opacity = "1";
        }, 600);
      } catch (err) {
        console.error("[Firebase Auth] Error Google Sign-In:", err);
        btnGoogle.disabled = false;
        btnGoogle.style.opacity = "1";
        mostrarAlertaAuth(traducirErrorAuth(err.code), "error");
      }
    });
  }

  // Recuperar contraseña
  if (linkForgot) {
    linkForgot.addEventListener("click", async (e) => {
      e.preventDefault();
      const emailInput = document.getElementById("modal-login-email");
      const email = emailInput ? emailInput.value.trim() : "";
      if (!email) {
        mostrarAlertaAuth("Por favor escribe tu correo electrónico en el campo superior para enviarte el enlace de recuperación.", "error");
        emailInput?.focus();
        return;
      }

      try {
        await auth.sendPasswordResetEmail(email);
        mostrarAlertaAuth(`Se ha enviado un correo a ${email} para restablecer tu contraseña. Revisa tu bandeja de entrada o spam.`, "success");
      } catch (err) {
        mostrarAlertaAuth(traducirErrorAuth(err.code), "error");
      }
    });
  }

  // Escuchar estado de sesión globalmente
  auth.onAuthStateChanged((user) => {
    const appHeader = document.querySelector(".header");
    const appMain = document.querySelector("main");
    if (user) {
      if (appHeader) appHeader.inert = false;
      if (appMain) appMain.inert = false;
      if (btnLogin) btnLogin.style.display = "none";
      if (profileBadge) profileBadge.style.display = "flex";

      const displayName = user.displayName || (user.email ? user.email.split("@")[0] : "Ciudadano");
      if (userNameText) userNameText.textContent = displayName;

      if (userAvatarInitials) {
        const inicial = displayName.charAt(0).toUpperCase();
        userAvatarInitials.textContent = inicial;
      }

      cerrarModalAuth();
    } else {
      if (appHeader) appHeader.inert = true;
      if (appMain) appMain.inert = true;
      if (btnLogin) btnLogin.style.display = "inline-flex";
      if (profileBadge) profileBadge.style.display = "none";
      abrirModalAuth("register");
    }
  });

  // Evento de Logout
  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      try {
        await auth.signOut();
        console.log("[Firebase Auth] Sesión cerrada");
        sessionStorage.removeItem("noai_dismissed_auth");
        window.location.reload();
      } catch (err) {
        console.error("Error al cerrar sesión:", err);
      }
    });
  }
}

/**
 * 2. Consultar noticias de una provincia en Firebase Realtime Database
 */
async function consultarNoticiasFirebase(provincia) {
  if (!window.NoAIFirebase || !window.NoAIFirebase.db) return null;
  const db = window.NoAIFirebase.db;
  const clave = normalizarClaveFirebase(provincia);

  try {
    const snapshot = await db.ref(`noticias/${clave}`).once("value");
    if (snapshot.exists()) {
      console.log(`[Firebase DB] Datos encontrados en Realtime DB para: ${provincia}`);
      return snapshot.val();
    }
    return null;
  } catch (error) {
    console.warn(`[Firebase DB] Error leyendo noticias de ${provincia}:`, error);
    return null;
  }
}

/** Guarda los videos recién consultados sin sobrescribir las demás secciones. */
async function guardarYoutubeFirebase(provincia, videos) {
  const firebase = window.NoAIFirebase;
  if (!firebase?.db || !firebase?.auth?.currentUser || !Array.isArray(videos)) return false;
  const clave = normalizarClaveFirebase(provincia);
  try {
    await firebase.db.ref(`noticias/${clave}`).update({
      provincia,
      youtube_videos: videos,
      actualizado_en: new Date().toISOString()
    });
    console.log(`[Firebase DB] Videos de YouTube guardados para ${provincia}: ${videos.length}`);
    return true;
  } catch (_) {
    console.warn(`[Firebase DB] No se pudieron guardar los videos de YouTube para ${provincia}.`);
    return false;
  }
}

/** Guarda publicaciones públicas de Reddit conservando el histórico existente. */
async function guardarRedditFirebase(provincia, posts) {
  const firebase = window.NoAIFirebase;
  if (!firebase?.db || !firebase?.auth?.currentUser || !Array.isArray(posts)) return false;
  const clave = normalizarClaveFirebase(provincia);
  const path = `noticias/${clave}`;
  try {
    const snapshot = await firebase.db.ref(`${path}/reddit_posts`).once("value");
    const previousValue = snapshot.val();
    const anteriores = Array.isArray(previousValue)
      ? previousValue
      : (previousValue && typeof previousValue === "object" ? Object.values(previousValue) : []);
    const porUrl = new Map();
    for (const post of [...posts, ...anteriores]) {
      if (!post || typeof post !== "object") continue;
      const url = String(post.url || post.link || "").trim();
      if (url && !porUrl.has(url)) porUrl.set(url, post);
    }
    const combinados = [...porUrl.values()].slice(0, 300);
    await firebase.db.ref(path).update({
      provincia,
      reddit_posts: combinados,
      actualizado_en: new Date().toISOString()
    });
    console.log(`[Firebase DB] Publicaciones de Reddit guardadas para ${provincia}: ${combinados.length}`);
    return true;
  } catch (_) {
    console.warn(`[Firebase DB] No se pudieron guardar las publicaciones de Reddit para ${provincia}.`);
    return false;
  }
}

/** Guarda titulares nuevos sin borrar el histórico previamente almacenado. */
async function guardarNoticiasFirebase(provincia, noticias) {
  const firebase = window.NoAIFirebase;
  if (!firebase?.db || !firebase?.auth?.currentUser || !Array.isArray(noticias) || noticias.length === 0) return null;
  const clave = normalizarClaveFirebase(provincia);
  const path = `noticias/${clave}`;
  try {
    const snapshot = await firebase.db.ref(`${path}/tiempo_real`).once("value");
    const previousValue = snapshot.val();
    const anteriores = Array.isArray(previousValue)
      ? previousValue
      : (previousValue && typeof previousValue === "object" ? Object.values(previousValue) : []);
    const combined = [];
    const seenUrls = new Set();
    const seenTitles = new Set();
    for (const item of [...noticias, ...anteriores]) {
      if (!item || typeof item !== "object") continue;
      const url = String(item.url || "").trim().toLowerCase();
      const title = String(item.titulo || "").trim().toLocaleLowerCase("es");
      if ((url && seenUrls.has(url)) || (title && seenTitles.has(title))) continue;
      if (url) seenUrls.add(url);
      if (title) seenTitles.add(title);
      if (!url && !title) continue;
      combined.push(item);
    }
    combined.sort((a, b) => {
      const localFirst = Number(b.alcance === "provincial") - Number(a.alcance === "provincial");
      return localFirst || new Date(b.fecha || 0).getTime() - new Date(a.fecha || 0).getTime();
    });
    await firebase.db.ref(path).update({
      provincia,
      tiempo_real: combined,
      actualizado_en: new Date().toISOString()
    });
    console.log(`[Firebase DB] Noticias locales guardadas para ${provincia}: ${noticias.length} nuevas; ${combined.length} en el histórico.`);
    return combined;
  } catch (error) {
    console.warn(`[Firebase DB] No se pudieron guardar las noticias de ${provincia}:`, error.message);
    return null;
  }
}

/**
 * 4. Consultar estadísticas del Dashboard en Firebase Realtime Database
 */
async function consultarDashboardStatsFirebase() {
  if (!window.NoAIFirebase || !window.NoAIFirebase.db) return null;
  const db = window.NoAIFirebase.db;

  try {
    const snapshot = await db.ref("dashboard/stats").once("value");
    if (snapshot.exists()) {
      console.log("[Firebase DB] Estadísticas de Dashboard leídas exitosamente de Realtime DB");
      return snapshot.val();
    }
    return null;
  } catch (error) {
    console.warn("[Firebase DB] Error consultando stats de dashboard:", error);
    return null;
  }
}

/**
 * 5. Suscripción en tiempo real a las estadísticas del Dashboard
 */
function escucharDashboardFirebase(callback) {
  if (!window.NoAIFirebase || !window.NoAIFirebase.db) return;
  const db = window.NoAIFirebase.db;

  db.ref("dashboard/stats").on("value", (snapshot) => {
    if (snapshot.exists() && typeof callback === "function") {
      console.log("[Firebase DB] Actualización en tiempo real recibida para Dashboard Stats");
      callback(snapshot.val());
    }
  });
}

/**
 * 7. Consultar Palabras Clave y Tendencias en Firebase Realtime Database
 */
async function consultarKeywordsFirebase() {
  if (!window.NoAIFirebase || !window.NoAIFirebase.db) return null;
  const db = window.NoAIFirebase.db;

  try {
    const snapshot = await db.ref("dashboard/keywords").once("value");
    if (snapshot.exists()) {
      console.log("[Firebase DB] Trending keywords leídas de Realtime DB");
      return snapshot.val();
    }
    return null;
  } catch (error) {
    console.warn("[Firebase DB] Error consultando keywords:", error);
    return null;
  }
}

/**
 * 8. Suscripción a Palabras Clave y Tendencias
 */
function escucharKeywordsFirebase(callback) {
  if (!window.NoAIFirebase || !window.NoAIFirebase.db) return;
  const db = window.NoAIFirebase.db;

  db.ref("dashboard/keywords").on("value", (snapshot) => {
    if (snapshot.exists() && typeof callback === "function") {
      console.log("[Firebase DB] Actualización en tiempo real para Trending Keywords");
      callback(snapshot.val());
    }
  });
}

// Exponer en window global
window.NoAIFirebaseSync = {
  abrirModalAuth,
  cerrarModalAuth,
  initFirebaseAuthUI,
  consultarNoticiasFirebase,
  guardarNoticiasFirebase,
  guardarYoutubeFirebase,
  guardarRedditFirebase,
  consultarDashboardStatsFirebase,
  escucharDashboardFirebase,
  consultarKeywordsFirebase,
  escucharKeywordsFirebase,
  normalizarClaveFirebase
};

// Inicializar automáticamente al cargar el script
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFirebaseAuthUI);
} else {
  initFirebaseAuthUI();
}
