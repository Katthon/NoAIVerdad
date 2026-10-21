/**
 * NoAIVerdad - Firebase Initialization & Configuration
 * Firebase Auth (Email/Password + Google) & Realtime Database
 */

const firebaseConfig = {
  apiKey: "AIzaSyCpXbOBJR8p14l4x9vCN_bHddMJDr5GFMo",
  authDomain: "noaiverdad-72aba.firebaseapp.com",
  databaseURL: "https://noaiverdad-72aba-default-rtdb.firebaseio.com",
  projectId: "noaiverdad-72aba",
  storageBucket: "noaiverdad-72aba.firebasestorage.app",
  messagingSenderId: "783175310756",
  appId: "1:783175310756:web:3b8b72b24873bbf496b531",
  measurementId: "G-9QSX5PPP6L"
};

// Inicializar Firebase
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.database();

// Configurar persistencia de sesión local (para mantener sesión en navegador y en Electron)
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
  .then(() => {
    console.log("[Firebase] Persistencia de sesión configurada en LOCAL");
  })
  .catch((err) => {
    console.warn("[Firebase] No se pudo fijar persistencia:", err);
  });

// Proveedor de Google Auth
const googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

/**
 * Guarda o actualiza los datos del usuario en Firebase Realtime Database
 */
const userSyncInFlight = new Map();

async function sincronizarUsuarioEnDatabase(user) {
  if (!user) return false;
  if (userSyncInFlight.has(user.uid)) return userSyncInFlight.get(user.uid);

  const syncPromise = (async () => {
    // Ensure the database request carries a current Firebase ID token.
    await user.getIdToken();
    const userRef = db.ref(`usuarios/${user.uid}`);
    const snapshot = await userRef.once('value');
    const existing = snapshot.val() || {};
    const now = new Date().toISOString();

    await userRef.update({
      email: user.email,
      nombre: user.displayName || existing.nombre || (user.email ? user.email.split('@')[0] : 'Ciudadano'),
      fotoURL: user.photoURL || existing.fotoURL || null,
      ultimo_acceso: now,
      creado_en: existing.creado_en || now,
      rol: existing.rol || "ciudadano"
    });
    console.log("[Firebase] Perfil de usuario sincronizado en Realtime Database");
    return true;
  })();

  userSyncInFlight.set(user.uid, syncPromise);
  try {
    return await syncPromise;
  } catch (error) {
    if (error.code === "PERMISSION_DENIED" || error.code === "database/permission-denied") {
      console.warn("[Firebase] Firebase rechazó la lectura/escritura del perfil. Revisa que las reglas desplegadas permitan al usuario autenticado leer y escribir /usuarios/{uid}.", error);
    } else {
      console.warn("[Firebase] Error sincronizando usuario:", error);
    }
    return false;
  } finally {
    userSyncInFlight.delete(user.uid);
  }
}

// Escuchar cambios de autenticación globalmente
auth.onAuthStateChanged((user) => {
  if (user) {
    console.log("[Firebase Auth] Usuario conectado:", user.email);
    sincronizarUsuarioEnDatabase(user);
  } else {
    console.log("[Firebase Auth] Sin sesión activa; el acceso requiere iniciar sesión o crear una cuenta.");
  }
});

window.NoAIFirebase = {
  auth,
  db,
  googleProvider,
  sincronizarUsuarioEnDatabase
};
