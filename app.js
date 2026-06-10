// Import Firebase SDK modules from official Google CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
  initializeFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  getFirestore,
  collection, 
  doc, 
  getDocs, 
  getDoc,
  addDoc,
  setDoc,
  deleteDoc,
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  runTransaction, 
  Timestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ==========================================
// Firebase Configuration & Initialization
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyAX-lkLApWhDu42OGz8UcppzLK74jgouTs",
  authDomain: "pasteleria-72c36.firebaseapp.com",
  projectId: "pasteleria-72c36",
  storageBucket: "pasteleria-72c36.firebasestorage.app",
  messagingSenderId: "937233099271",
  appId: "1:937233099271:web:044958babaccc03d9c58a2",
  measurementId: "G-S2TB22EE64"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize a secondary auth helper instance to create users without hijacking admin session
let secondaryAuth = null;
try {
  const secondaryApp = initializeApp(firebaseConfig, "SecondaryApp");
  secondaryAuth = getAuth(secondaryApp);
} catch (err) {
  console.error("Secondary app init warning:", err);
}

// Initialize Firestore with Offline Caching Enabled and Safe Fallback
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
} catch (cacheErr) {
  console.warn("No se pudo iniciar Firestore con caché local persistente, usando configuración base:", cacheErr);
  db = getFirestore(app);
}

// Initialize Auth
const auth = getAuth(app);

// ==========================================
// JWT & Offline Authentication Helpers
// ==========================================
function base64UrlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return decodeURIComponent(escape(atob(base64)));
}

function simpleHash(str, secret = 'salt_elmamalon') {
  let hash = 0;
  const combined = str + secret;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

function generateJWT(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const secret = "elmamalon_secret_key";
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlEncode(simpleHash(signatureInput, secret));
  return `${signatureInput}.${signature}`;
}

function verifyAndDecodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, signature] = parts;
    const secret = "elmamalon_secret_key";
    const expectedSignature = base64UrlEncode(simpleHash(`${encodedHeader}.${encodedPayload}`, secret));
    if (signature !== expectedSignature) {
      console.warn("Firma JWT inválida");
      return null;
    }
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp && Date.now() > payload.exp) {
      console.warn("JWT expirado");
      return null;
    }
    return payload;
  } catch (err) {
    console.error("Fallo al verificar JWT:", err);
    return null;
  }
}

function cacheUserForOffline(username, password, role, uid) {
  const localUsers = JSON.parse(localStorage.getItem('local_users') || '{}');
  localUsers[username] = {
    passwordHash: simpleHash(password, 'salt_elmamalon'),
    role: role,
    uid: uid
  };
  localStorage.setItem('local_users', JSON.stringify(localUsers));
}

async function attemptBackgroundOnlineReauth() {
  if (navigator.onLine && authUser && authUser.isLocalJWT) {
    const username = authUser.email.split('@')[0];
    const plainPassword = sessionStorage.getItem('temp_offline_pass');
    if (plainPassword) {
      console.log("Intentando re-autenticación automática en línea con Firebase Auth...");
      const { email, password: securePassword } = formatAuthCredentials(username, plainPassword);
      try {
        await signInWithEmailAndPassword(auth, email, securePassword);
        sessionStorage.removeItem('temp_offline_pass');
        console.log("Re-autenticación en línea exitosa.");
      } catch (err) {
        console.warn("No se pudo re-autenticar automáticamente en línea:", err.message);
      }
    }
  }
}

// ==========================================================
// Application State
// ==========================================
let products = [];
let cart = [];
let sales = [];
let users = [];
let categories = [];
let selectedCategory = 'all';
let searchQueryParams = { pos: '', inventory: '' };
let activeTab = 'pos';
let currentSalePaymentMethod = 'Efectivo';
let authUser = null;
let authUserRole = 'usuario';

// Realtime listeners storage for clean unsubscription
let productsUnsubscribe = null;
let salesUnsubscribe = null;
let usersUnsubscribe = null;
let categoriesUnsubscribe = null;

// ==========================================
// DOM Elements Cache
// ==========================================
const elements = {
  toastContainer: document.getElementById('toast-container'),
  loadingOverlay: document.getElementById('loading-overlay'),
  
  // Views
  authView: document.getElementById('auth-view'),
  appShell: document.getElementById('app-shell'),
  posView: document.getElementById('pos-view'),
  inventoryView: document.getElementById('inventory-view'),
  historyView: document.getElementById('history-view'),
  
  // Auth Form
  authForm: document.getElementById('auth-form'),
  authUsername: document.getElementById('auth-username'),
  authPassword: document.getElementById('auth-password'),
  authBtn: document.getElementById('auth-btn'),
  authSubtitle: document.getElementById('auth-subtitle'),
  logoutBtn: document.getElementById('logout-btn'),
  connectionText: document.getElementById('connection-text'),
  connectionStatus: document.querySelector('.connection-status'),
  
  // Nav
  navItems: document.querySelectorAll('.nav-item'),
  
  // POS (Vender)
  posSearch: document.getElementById('pos-search'),
  clearPosSearch: document.getElementById('clear-pos-search'),
  categoryChips: document.getElementById('category-chips'),
  posProductsGrid: document.getElementById('pos-products-grid'),
  cartTrigger: document.getElementById('cart-trigger'),
  cartBadge: document.getElementById('cart-badge'),
  cartTriggerTotalValue: document.getElementById('cart-trigger-total-value'),
  
  // Cart Drawer
  cartBackdrop: document.getElementById('cart-backdrop'),
  cartDrawer: document.getElementById('cart-drawer'),
  closeCartBtn: document.getElementById('close-cart-btn'),
  cartItemsContainer: document.getElementById('cart-items-container'),
  cartSubtotal: document.getElementById('cart-subtotal'),
  cartTotal: document.getElementById('cart-total'),
  checkoutBtn: document.getElementById('checkout-btn'),
  
  // Checkout Modal
  checkoutModal: document.getElementById('checkout-modal'),
  closeCheckoutBtn: document.getElementById('close-checkout-btn'),
  cancelCheckoutBtn: document.getElementById('cancel-checkout-btn'),
  checkoutTotalDisplay: document.getElementById('checkout-total-display'),
  paymentMethodCards: document.querySelectorAll('.pay-method-card'),
  cashPaymentFields: document.getElementById('cash-payment-fields'),
  cashReceived: document.getElementById('cash-received'),
  quickCashBtns: document.querySelectorAll('.quick-cash-btn'),
  quickCashExact: document.getElementById('quick-cash-exact'),
  checkoutChangeDisplay: document.getElementById('checkout-change-display'),
  completeSaleBtn: document.getElementById('complete-sale-btn'),
  
  // Inventory (Gestión)
  addProductBtn: document.getElementById('add-product-btn'),
  inventorySearch: document.getElementById('inventory-search'),
  inventoryList: document.getElementById('inventory-list'),
  
  // Product Modal
  productModal: document.getElementById('product-modal'),
  closeProductBtn: document.getElementById('close-product-btn'),
  cancelProductBtn: document.getElementById('cancel-product-btn'),
  productForm: document.getElementById('product-form'),
  productModalTitle: document.getElementById('product-modal-title'),
  productId: document.getElementById('product-id'),
  prodName: document.getElementById('prod-name'),
  prodPrice: document.getElementById('prod-price'),
  prodCost: document.getElementById('prod-cost'),
  prodStock: document.getElementById('prod-stock'),
  prodCategory: document.getElementById('prod-category'),
  prodBarcode: document.getElementById('prod-barcode'),
  prodImageInput: document.getElementById('prod-image-input'),
  imagePreviewPlaceholder: document.getElementById('image-preview-placeholder'),
  prodImagePreview: document.getElementById('prod-image-preview'),
  removeImageBtn: document.getElementById('remove-image-btn'),
  
  // History / Reports
  dashRevenue: document.getElementById('dash-revenue'),
  dashProfit: document.getElementById('dash-profit'),
  dashSalesCount: document.getElementById('dash-sales-count'),
  historyDateFilter: document.getElementById('history-date-filter'),
  historySalesList: document.getElementById('history-sales-list'),

  // New Subviews, Users, and Reports elements
  productsSubview: document.getElementById('products-subview'),
  usersSubview: document.getElementById('users-subview'),
  salesSubview: document.getElementById('sales-subview'),
  reportsSubview: document.getElementById('reports-subview'),
  usersList: document.getElementById('users-list'),
  addUserBtn: document.getElementById('add-user-btn'),
  reportsProductsList: document.getElementById('reports-products-list'),
  
  // User Modal
  userModal: document.getElementById('user-modal'),
  closeUserBtn: document.getElementById('close-user-btn'),
  cancelUserBtn: document.getElementById('cancel-user-btn'),
  userForm: document.getElementById('user-form'),
  userUsername: document.getElementById('user-username'),
  userPassword: document.getElementById('user-password'),
  userRole: document.getElementById('user-role'),
  saveUserBtn: document.getElementById('save-user-btn'),

  // New Categories subview & Modal elements
  categoriesSubview: document.getElementById('categories-subview'),
  categoriesList: document.getElementById('categories-list'),
  addCategoryBtn: document.getElementById('add-category-btn'),
  categoryModal: document.getElementById('category-modal'),
  closeCategoryBtn: document.getElementById('close-category-btn'),
  cancelCategoryBtn: document.getElementById('cancel-category-btn'),
  categoryForm: document.getElementById('category-form'),
  categoryName: document.getElementById('category-name'),
  categoryId: document.getElementById('category-id')
};

// Setup Backdrop click handler to close dialogs natively when clicking outside their contents
[
  elements.cartDrawer,
  elements.checkoutModal,
  elements.productModal,
  elements.categoryModal,
  elements.userModal
].forEach(dialog => {
  if (dialog) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        dialog.close();
      }
    });
  }
});

// ==========================================
// Image Upload & Compression Logic
// ==========================================
let currentProductImageBase64 = '';

// Clear/Reset Image Input and Preview Elements
function resetImageUploadUI() {
  currentProductImageBase64 = '';
  elements.prodImageInput.value = '';
  elements.prodImagePreview.src = '';
  elements.prodImagePreview.classList.add('hidden');
  elements.imagePreviewPlaceholder.classList.remove('hidden');
  elements.removeImageBtn.classList.add('hidden');
}

// Compress any image file to Web-friendly Base64 JPEG
function compressImage(file, maxWidth = 300, maxQuality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        // Resize dimensions keeping aspect ratio
        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxWidth) {
            width = Math.round((width * maxWidth) / height);
            height = maxWidth;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Convert canvas image to base64 with quality compression
        const compressedBase64 = canvas.toDataURL('image/jpeg', maxQuality);
        resolve(compressedBase64);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}

// Trigger hidden file picker when placeholder is clicked
elements.imagePreviewPlaceholder.addEventListener('click', () => {
  elements.prodImageInput.click();
});

// File change listener: reads, compresses, and displays preview
elements.prodImageInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  showLoading(true, 'Procesando imagen...');
  try {
    const base64Data = await compressImage(file, 300, 0.7);
    currentProductImageBase64 = base64Data;
    
    // Set preview source and show it
    elements.prodImagePreview.src = base64Data;
    elements.prodImagePreview.classList.remove('hidden');
    elements.imagePreviewPlaceholder.classList.add('hidden');
    elements.removeImageBtn.classList.remove('hidden');
  } catch (err) {
    console.error("Compression error:", err);
    showToast('Error al procesar la imagen.', 'error');
  } finally {
    showLoading(false);
  }
});

// Remove/Reset image button
elements.removeImageBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // Avoid triggering file picker click
  resetImageUploadUI();
});


// ==========================================
// Toast Notification Utility
// ==========================================
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'info';
  if (type === 'success') icon = 'check_circle';
  if (type === 'error') icon = 'error';
  
  toast.innerHTML = `
    <span class="material-icons">${icon}</span>
    <span class="toast-message">${message}</span>
  `;
  
  elements.toastContainer.appendChild(toast);
  
  // Slide out and remove
  setTimeout(() => {
    toast.style.animation = 'slideDownIn 0.3s reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Show/Hide Global Spinner
function showLoading(show, message = 'Cargando...') {
  const textEl = elements.loadingOverlay.querySelector('p');
  if (textEl) textEl.textContent = message;
  
  if (show) {
    elements.loadingOverlay.style.display = 'flex';
    elements.loadingOverlay.offsetHeight; // Force reflow
    elements.loadingOverlay.classList.remove('fade-out');
  } else {
    elements.loadingOverlay.classList.add('fade-out');
  }
}

// Add transitionend listener to completely hide the overlay after fade-out
if (elements.loadingOverlay) {
  elements.loadingOverlay.addEventListener('transitionend', () => {
    if (elements.loadingOverlay.classList.contains('fade-out')) {
      elements.loadingOverlay.style.display = 'none';
    }
  });
}

// ==========================================
// Online / Offline Status
// ==========================================
function updateConnectionStatus() {
  const isOnline = navigator.onLine;
  if (isOnline) {
    elements.connectionStatus.className = 'connection-status online';
    elements.connectionText.textContent = 'En línea';
    showToast('Conectado a internet. Datos sincronizados.', 'success');
  } else {
    elements.connectionStatus.className = 'connection-status offline';
    elements.connectionText.textContent = 'Modo Offline';
    showToast('Sin conexión a internet. Los cambios se guardarán localmente y se sincronizarán al reconectar.', 'info');
  }
}
window.addEventListener('online', () => {
  updateConnectionStatus();
  attemptBackgroundOnlineReauth();
});
window.addEventListener('offline', updateConnectionStatus);

// ==========================================
// Authentication Controller
// ==========================================

// Map standard username to Firebase email format, and pad password
function formatAuthCredentials(username, password) {
  const cleanUsername = username.trim().toLowerCase();
  const email = `${cleanUsername}@elmamalon.com`;
  // Firebase Auth password requirements: min 6 chars. 
  // We prefix to satisfy length of 4+ digits/chars.
  const paddedPassword = `pos_${password.trim()}`;
  return { email, password: paddedPassword };
}

// Auth State Observer
onAuthStateChanged(auth, async (user) => {
  authUser = user;
  if (user) {
    console.log("Usuario autenticado:", user.email);
    // Hide auth, show app shell
    elements.authView.classList.add('hidden');
    elements.appShell.classList.remove('hidden');
    
    // Reset forms & cart
    elements.authForm.reset();
    cart = [];
    updateCartUI();
    
    // Self-healing database check: ensure this user exists in Firestore 'users' collection
    let userRole = 'usuario';
    const username = user.email.split('@')[0];
    try {
      const userRef = doc(db, 'users', user.uid);
      const userDoc = await getDoc(userRef);
      if (!userDoc.exists()) {
        userRole = username === 'admin' ? 'admin' : 'usuario';
        await setDoc(userRef, {
          username: username,
          role: userRole,
          createdAt: Timestamp.now()
        });
      } else {
        userRole = userDoc.data().role || 'usuario';
      }
    } catch (dbErr) {
      console.warn("No se pudo guardar/leer el perfil del usuario en Firestore:", dbErr.message);
      // Fallback based on email
      userRole = username === 'admin' ? 'admin' : 'usuario';
    }

    authUserRole = userRole;
    applyRoleBasedUI(userRole);

    // Generate and save JWT token
    const payload = {
      uid: user.uid,
      username: username,
      role: userRole,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000
    };
    const token = generateJWT(payload);
    localStorage.setItem('jwt_token', token);

    // Start Realtime Data Listeners
    startRealtimeListeners();
    
    // Restore saved routing tab or fallback to POS
    const savedTab = location.hash.replace('#/', '');
    switchTab(savedTab === 'inventory' || savedTab === 'history' ? savedTab : 'pos');
    
    showLoading(false);
    showToast(`Bienvenido de vuelta`, 'success');
  } else {
    console.log("Sin sesión activa en Firebase Auth.");
    
    // Check if we have a valid local JWT token to keep local login
    const savedToken = localStorage.getItem('jwt_token');
    const payload = savedToken ? verifyAndDecodeJWT(savedToken) : null;
    
    if (payload) {
      console.log("Manteniendo sesión local mediante JWT activo:", payload.username);
      authUser = {
        uid: payload.uid,
        email: `${payload.username}@elmamalon.com`,
        isLocalJWT: true
      };
      authUserRole = payload.role;
      
      elements.authView.classList.add('hidden');
      elements.appShell.classList.remove('hidden');
      applyRoleBasedUI(authUserRole);
      
      startRealtimeListeners();
      
      const savedTab = location.hash.replace('#/', '');
      switchTab(savedTab === 'inventory' || savedTab === 'history' ? savedTab : 'pos');
      
      showLoading(false);
      attemptBackgroundOnlineReauth();
    } else {
      // Hide app shell, show auth
      elements.appShell.classList.add('hidden');
      elements.authView.classList.remove('hidden');
      
      // Stop Realtime Data Listeners
      stopRealtimeListeners();
      
      authUserRole = 'usuario';
      applyRoleBasedUI('usuario');
      
      showLoading(false);
    }
  }
});

// Dynamic UI adjustments based on user role
function applyRoleBasedUI(role) {
  const isAdmin = role === 'admin';
  
  // 1. Show/Hide Nuevo Producto button
  if (elements.addProductBtn) {
    if (isAdmin) {
      elements.addProductBtn.classList.remove('hidden');
    } else {
      elements.addProductBtn.classList.add('hidden');
    }
  }

  // 2. Show/Hide subtabs in Inventory (Categories and Users)
  const subviewButtons = document.querySelectorAll('.inventory-container .view-toggle .toggle-btn');
  subviewButtons.forEach(btn => {
    const subview = btn.dataset.subview;
    if (subview === 'users' || subview === 'categories') {
      if (isAdmin) {
        btn.classList.remove('hidden');
      } else {
        btn.classList.add('hidden');
      }
    }
  });

  // If the active subview was users or categories, and we are not admin, switch back to products subview
  const activeSubbtn = document.querySelector('.inventory-container .view-toggle .toggle-btn.active');
  if (!isAdmin && activeSubbtn && (activeSubbtn.dataset.subview === 'users' || activeSubbtn.dataset.subview === 'categories')) {
    const productsBtn = document.querySelector('.inventory-container .view-toggle .toggle-btn[data-subview="products"]');
    if (productsBtn) {
      productsBtn.click();
    }
  }

  // Re-render inventory list to apply edit/delete button hiding
  renderInventory();
}

// Handle login form submission
elements.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = elements.authUsername.value.trim().toLowerCase();
  const password = elements.authPassword.value;

  if (password.length < 4) {
    showToast('La contraseña debe tener mínimo 4 caracteres o dígitos.', 'error');
    return;
  }

  showLoading(true, 'Iniciando sesión...');
  
  // Offline Login Fallback
  if (!navigator.onLine) {
    console.log("Iniciando sesión en modo Offline con credenciales cacheadas...");
    const localUsers = JSON.parse(localStorage.getItem('local_users') || '{}');
    const cachedUser = localUsers[username];
    
    if (cachedUser && cachedUser.passwordHash === simpleHash(password, 'salt_elmamalon')) {
      // Generate offline JWT
      const payload = {
        uid: cachedUser.uid,
        username: username,
        role: cachedUser.role,
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000
      };
      const token = generateJWT(payload);
      localStorage.setItem('jwt_token', token);
      sessionStorage.setItem('temp_offline_pass', password);
      
      authUser = {
        uid: cachedUser.uid,
        email: `${username}@elmamalon.com`,
        isLocalJWT: true
      };
      authUserRole = cachedUser.role;
      
      // Setup app view
      elements.authView.classList.add('hidden');
      elements.appShell.classList.remove('hidden');
      elements.authForm.reset();
      cart = [];
      updateCartUI();
      applyRoleBasedUI(authUserRole);
      
      // Start offline database listener
      startRealtimeListeners();
      
      const savedTab = location.hash.replace('#/', '');
      switchTab(savedTab === 'inventory' || savedTab === 'history' ? savedTab : 'pos');
      
      showLoading(false);
      showToast('Inicio de sesión Offline exitoso (JWT local)', 'success');
      return;
    } else {
      showLoading(false);
      showToast('Sin conexión a internet y credenciales locales incorrectas o no registradas.', 'error');
      return;
    }
  }

  const { email, password: securePassword } = formatAuthCredentials(username, password);

  try {
    // Login standard user in Firebase Auth
    const userCredential = await signInWithEmailAndPassword(auth, email, securePassword);
    const user = userCredential.user;
    
    // Fetch role to cache it for offline login fallback
    let userRole = 'usuario';
    try {
      const userRef = doc(db, 'users', user.uid);
      const userDoc = await getDoc(userRef);
      if (userDoc.exists()) {
        userRole = userDoc.data().role || 'usuario';
      } else {
        userRole = username === 'admin' ? 'admin' : 'usuario';
      }
    } catch (e) {
      userRole = username === 'admin' ? 'admin' : 'usuario';
    }
    
    // Cache credentials locally for offline fallback
    cacheUserForOffline(username, password, userRole, user.uid);
    
    // Generate and save JWT token
    const payload = {
      uid: user.uid,
      username: username,
      role: userRole,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000
    };
    const token = generateJWT(payload);
    localStorage.setItem('jwt_token', token);
    
  } catch (err) {
    // SELF-HEALING: If default admin account does not exist yet and password is correct, auto-register and retry
    if (username === 'admin' && password === 'admin' && (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential')) {
      try {
        console.log("Creando administrador por defecto...");
        if (secondaryAuth) {
          const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, securePassword);
          const user = userCredential.user;
          await setDoc(doc(db, 'users', user.uid), {
            username: 'admin',
            role: 'admin',
            createdAt: Timestamp.now()
          });
          await signOut(secondaryAuth);
          
          // Retry login
          const retryCred = await signInWithEmailAndPassword(auth, email, securePassword);
          const retryUser = retryCred.user;
          
          // Cache and generate JWT
          cacheUserForOffline('admin', 'admin', 'admin', retryUser.uid);
          const payload = {
            uid: retryUser.uid,
            username: 'admin',
            role: 'admin',
            exp: Date.now() + 7 * 24 * 60 * 60 * 1000
          };
          const token = generateJWT(payload);
          localStorage.setItem('jwt_token', token);
          return; // Success!
        }
      } catch (regErr) {
        console.error("No se pudo registrar administrador por defecto:", regErr);
      }
    }

    showLoading(false);
    console.error("Auth Error:", err.code, err.message);
    
    let errMsg = 'Ocurrió un error al autenticar.';
    if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
      errMsg = 'Usuario o contraseña incorrectos.';
    } else if (err.code === 'auth/network-request-failed') {
      errMsg = 'Error de red. Verifica tu conexión.';
    }
    showToast(errMsg, 'error');
  }
});

// Logout action
elements.logoutBtn.addEventListener('click', () => {
  if (confirm('¿Seguro que deseas cerrar la sesión?')) {
    showLoading(true, 'Cerrando sesión...');
    localStorage.removeItem('jwt_token'); // Clear JWT!
    signOut(auth)
      .then(() => {
        // Clean local state in case we were logged in via local JWT
        authUser = null;
        authUserRole = 'usuario';
        elements.appShell.classList.add('hidden');
        elements.authView.classList.remove('hidden');
        stopRealtimeListeners();
        applyRoleBasedUI('usuario');
        showLoading(false);
        showToast('Sesión cerrada correctamente.', 'info');
      })
      .catch((err) => {
        // Force logout even if signOut fails (e.g. offline)
        authUser = null;
        authUserRole = 'usuario';
        elements.appShell.classList.add('hidden');
        elements.authView.classList.remove('hidden');
        stopRealtimeListeners();
        applyRoleBasedUI('usuario');
        showLoading(false);
        showToast('Sesión cerrada localmente.', 'info');
      });
  }
});

// ==========================================
// Realtime Data Sync (Firestore Listeners)
// ==========================================
function startRealtimeListeners() {
  stopRealtimeListeners(); // Safety check
  
  showLoading(true, 'Sincronizando datos...');

  // 1. Products Listener
  const productsQuery = query(collection(db, 'products'), orderBy('name', 'asc'));
  productsUnsubscribe = onSnapshot(productsQuery, (snapshot) => {
    products = [];
    snapshot.forEach((doc) => {
      products.push({ id: doc.id, ...doc.data() });
    });
    
    // Auto-migrate unique product categories if database categories are empty
    if (products.length > 0) {
      migrateCategoriesIfNeeded(products);
    }
    
    // Update active UIs
    renderPOSProducts();
    renderInventory();
    renderCategoryChips();
    
    // Sync quantities in active cart with updated products stock
    syncCartWithStock();
    
    showLoading(false);
  }, (error) => {
    console.error("Products sync error:", error);
    showToast('Error al sincronizar inventario.', 'error');
    showLoading(false);
  });

  // 2. Sales Listener (Fetch today's sales for dashboard calculations)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfPeriod = Timestamp.fromDate(today);

  // We load sales ordered by date
  const salesQuery = query(
    collection(db, 'sales'),
    where('createdAt', '>=', startOfPeriod),
    orderBy('createdAt', 'desc')
  );
  
  salesUnsubscribe = onSnapshot(salesQuery, (snapshot) => {
    sales = [];
    snapshot.forEach((doc) => {
      sales.push({ id: doc.id, ...doc.data() });
    });
    
    // Re-render History, Dashboard Metrics, and Product Reports
    updateDashboardMetrics();
    renderHistoryList();
    renderProductSalesReport();
  }, (error) => {
    console.error("Sales sync error:", error);
    showLoading(false);
    if (error.code === 'failed-precondition') {
      console.warn("Index needed, falling back to client-side sales filtering.");
      loadAllSalesFallback();
    } else {
      showToast('Error de permisos al sincronizar ventas.', 'error');
    }
  });

  // 3. Users Listener
  const usersQuery = query(collection(db, 'users'), orderBy('username', 'asc'));
  usersUnsubscribe = onSnapshot(usersQuery, (snapshot) => {
    users = [];
    snapshot.forEach((doc) => {
      users.push({ id: doc.id, ...doc.data() });
    });
    renderUsers();
  }, (error) => {
    console.error("Users list sync error:", error);
    showLoading(false);
  });

  // 4. Categories Listener
  const categoriesQuery = query(collection(db, 'categories'), orderBy('name', 'asc'));
  categoriesUnsubscribe = onSnapshot(categoriesQuery, (snapshot) => {
    categories = [];
    snapshot.forEach((doc) => {
      categories.push({ id: doc.id, ...doc.data() });
    });
    renderCategories();
    updateProductCategoryDropdown();
    renderCategoryChips();
  }, (error) => {
    if (error.code === 'permission-denied') {
      console.warn("La colección 'categories' no tiene permisos de lectura configurados en Firebase Console. Se activó el fallback local (compilación dinámica a partir de productos).");
      updateProductCategoryDropdown();
      renderCategoryChips();
    } else {
      console.error("Categories sync error:", error);
    }
    showLoading(false);
  });
}

function stopRealtimeListeners() {
  if (productsUnsubscribe) {
    productsUnsubscribe();
    productsUnsubscribe = null;
  }
  if (salesUnsubscribe) {
    salesUnsubscribe();
    salesUnsubscribe = null;
  }
  if (usersUnsubscribe) {
    usersUnsubscribe();
    usersUnsubscribe = null;
  }
  if (categoriesUnsubscribe) {
    categoriesUnsubscribe();
    categoriesUnsubscribe = null;
  }
}

// Fallback in case of index requirements errors
function loadAllSalesFallback() {
  const salesQuery = query(collection(db, 'sales'), orderBy('createdAt', 'desc'));
  salesUnsubscribe = onSnapshot(salesQuery, (snapshot) => {
    sales = [];
    snapshot.forEach((doc) => {
      sales.push({ id: doc.id, ...doc.data() });
    });
    updateDashboardMetrics();
    renderHistoryList();
  }, (error) => {
    console.error("Sales fallback sync error:", error);
  });
}

// Ensure items in cart do not exceed new stock levels updated in real-time
function syncCartWithStock() {
  let changed = false;
  cart = cart.map(item => {
    const product = products.find(p => p.id === item.id);
    if (!product) {
      changed = true;
      return null; // Product deleted from db
    }
    if (item.quantity > product.stock) {
      changed = true;
      item.quantity = product.stock;
    }
    item.stock = product.stock; // Update local stock ref
    return item;
  }).filter(item => item !== null && item.quantity > 0);

  if (changed) {
    showToast('El carrito se actualizó debido a cambios en el inventario.', 'info');
    updateCartUI();
    renderPOSProducts();
  }
}

// ==========================================
// Navigation & Router
// ==========================================
function switchTab(tabId) {
  activeTab = tabId;
  location.hash = `#/${tabId}`;

  // Hide all sections
  elements.posView.classList.add('hidden');
  elements.inventoryView.classList.add('hidden');
  elements.historyView.classList.add('hidden');
  
  // Show active section
  const activeSection = document.getElementById(`${tabId}-view`);
  if (activeSection) activeSection.classList.remove('hidden');

  // Update Nav Bar Items
  elements.navItems.forEach(item => {
    if (item.dataset.target === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Actions on specific tab load
  if (tabId === 'history') {
    // Refresh date filter display
    handleHistoryDateFilterChange();
  }
}

elements.navItems.forEach(item => {
  item.addEventListener('click', () => {
    switchTab(item.dataset.target);
  });
});

// Navigate button from empty states
document.querySelectorAll('.navigate-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.target);
  });
});

// ==========================================
// POS / Vender Module
// ==========================================

// Dynamically compile categories from Firestore collection and active products
function renderCategoryChips() {
  const definedCats = categories.map(c => c.name.trim());
  const productCats = products.map(p => p.category.trim()).filter(c => c !== '');
  const allCategories = ['all', ...new Set([...definedCats, ...productCats])];
  
  // Keep active category selected if it still exists, otherwise reset to 'all'
  if (!allCategories.includes(selectedCategory)) {
    selectedCategory = 'all';
  }

  elements.categoryChips.innerHTML = allCategories.map(cat => {
    const isActive = cat === selectedCategory;
    const label = cat === 'all' ? 'Todos' : cat;
    return `<button class="chip ${isActive ? 'active' : ''}" data-category="${cat}">${label}</button>`;
  }).join('');

  // Add click listeners to new chips
  elements.categoryChips.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedCategory = chip.dataset.category;
      elements.categoryChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderPOSProducts();
    });
  });
}

// Filter and render POS Products list
function renderPOSProducts() {
  const query = searchQueryParams.pos.toLowerCase().trim();
  
  // Apply search query and category filters
  const filtered = products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query);
    const matchesCategory = selectedCategory === 'all' || p.category.trim().toLowerCase() === selectedCategory.toLowerCase();
    return matchesSearch && matchesCategory;
  });

  if (filtered.length === 0) {
    elements.posProductsGrid.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">search_off</span>
        <p>${products.length === 0 ? 'No hay productos registrados en el sistema.' : 'Ningún producto coincide con la búsqueda.'}</p>
      </div>
    `;
    return;
  }

  elements.posProductsGrid.innerHTML = filtered.map(p => {
    const cartItem = cart.find(item => item.id === p.id);
    const qtyInCart = cartItem ? cartItem.quantity : 0;
    const isOutOfStock = p.stock <= 0;
    
    let stockClass = '';
    if (p.stock <= 0) stockClass = 'danger';
    else if (p.stock <= 5) stockClass = 'warning';
    
    return `
      <div class="product-card ${isOutOfStock ? 'out-of-stock' : ''} ${qtyInCart > 0 ? 'has-items' : ''}" 
           data-id="${p.id}" onclick="this.classList.contains('out-of-stock') ? null : window.addToCart('${p.id}')">
        ${qtyInCart > 0 ? `<div class="card-qty-badge">${qtyInCart}</div>` : ''}
        <div class="product-card-img-wrapper">
          ${p.image ? `<img src="${p.image}" class="product-card-img" alt="${escapeHtml(p.name)}">` : `<span class="material-icons product-card-no-img">image</span>`}
        </div>
        <div class="product-details">
          <span class="product-name">${escapeHtml(p.name)}</span>
          <span class="product-price">$${Number(p.price).toFixed(2)}</span>
          <span class="product-stock-tag ${stockClass}">
            ${isOutOfStock ? 'Sin Stock' : `Stock: ${p.stock}`}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

// Make globally accessible from HTML context
window.addToCart = (productId) => {
  const product = products.find(p => p.id === productId);
  if (!product || product.stock <= 0) return;

  const existing = cart.find(item => item.id === productId);
  if (existing) {
    if (existing.quantity >= product.stock) {
      showToast(`No puedes vender más de ${product.stock} unidades en stock de ${product.name}`, 'warning');
      return;
    }
    existing.quantity += 1;
  } else {
    cart.push({
      id: product.id,
      name: product.name,
      price: Number(product.price),
      cost: Number(product.cost || 0),
      stock: product.stock,
      quantity: 1
    });
  }

  updateCartUI();
  renderPOSProducts();
};

// POS Search listeners
elements.posSearch.addEventListener('input', (e) => {
  searchQueryParams.pos = e.target.value;
  if (searchQueryParams.pos.length > 0) {
    elements.clearPosSearch.classList.remove('hidden');
  } else {
    elements.clearPosSearch.classList.add('hidden');
  }
  renderPOSProducts();
});

elements.clearPosSearch.addEventListener('click', () => {
  elements.posSearch.value = '';
  searchQueryParams.pos = '';
  elements.clearPosSearch.classList.add('hidden');
  renderPOSProducts();
});

// ==========================================
// Cart Management (Carrito)
// ==========================================
function updateCartUI() {
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const totalVal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  // Badge trigger display
  elements.cartBadge.textContent = itemCount;
  elements.cartTriggerTotalValue.textContent = `$${totalVal.toFixed(2)}`;
  
  if (itemCount > 0) {
    elements.cartTrigger.classList.add('visible');
  } else {
    elements.cartTrigger.classList.remove('visible');
    closeCartDrawer();
  }

  // Inside Drawer UIs
  elements.cartSubtotal.textContent = `$${totalVal.toFixed(2)}`;
  elements.cartTotal.textContent = `$${totalVal.toFixed(2)}`;
  
  if (cart.length === 0) {
    elements.cartItemsContainer.innerHTML = `
      <div class="empty-cart-state">
        <span class="material-icons">add_shopping_cart</span>
        <p>El carrito está vacío. Agrega productos de la lista.</p>
      </div>
    `;
    elements.checkoutBtn.disabled = true;
  } else {
    elements.cartItemsContainer.innerHTML = cart.map(item => `
      <div class="cart-item">
        <div class="cart-item-details">
          <span class="cart-item-name">${escapeHtml(item.name)}</span>
          <div class="cart-item-prices">
            <span class="cart-item-unit-price">${item.quantity} x $${item.price.toFixed(2)}</span>
            <span class="cart-item-total-price">$${(item.price * item.quantity).toFixed(2)}</span>
          </div>
        </div>
        <div class="cart-item-actions">
          <div class="qty-control">
            <button class="qty-btn" onclick="window.updateCartQty('${item.id}', -1)">
              <span class="material-icons">remove</span>
            </button>
            <span class="qty-val">${item.quantity}</span>
            <button class="qty-btn" onclick="window.updateCartQty('${item.id}', 1)">
              <span class="material-icons">add</span>
            </button>
          </div>
          <button class="btn-icon remove-item-btn" onclick="window.removeCartItem('${item.id}')">
            <span class="material-icons">delete</span>
          </button>
        </div>
      </div>
    `).join('');
    
    elements.checkoutBtn.disabled = false;
  }
}

// Global actions for items inside cart
window.updateCartQty = (productId, delta) => {
  const item = cart.find(i => i.id === productId);
  if (!item) return;

  const product = products.find(p => p.id === productId);
  const newQty = item.quantity + delta;

  if (newQty <= 0) {
    window.removeCartItem(productId);
    return;
  }

  if (product && newQty > product.stock) {
    showToast(`Solo quedan ${product.stock} unidades en stock de ${product.name}`, 'warning');
    return;
  }

  item.quantity = newQty;
  updateCartUI();
  renderPOSProducts();
};

window.removeCartItem = (productId) => {
  cart = cart.filter(item => item.id !== productId);
  updateCartUI();
  renderPOSProducts();
};

// Open/Close Cart Drawer
elements.cartTrigger.addEventListener('click', openCartDrawer);
elements.closeCartBtn.addEventListener('click', closeCartDrawer);

function openCartDrawer() {
  if (cart.length === 0) return;
  if (elements.cartDrawer) {
    elements.cartDrawer.showModal();
  }
}

function closeCartDrawer() {
  if (elements.cartDrawer) {
    elements.cartDrawer.close();
  }
}

// ==========================================
// Checkout Flow (Procesamiento de Pago)
// ==========================================
elements.checkoutBtn.addEventListener('click', () => {
  closeCartDrawer();
  
  const totalVal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  elements.checkoutTotalDisplay.textContent = `$${totalVal.toFixed(2)}`;
  
  // Reset payment states
  currentSalePaymentMethod = 'Efectivo';
  elements.paymentMethodCards.forEach(card => {
    if (card.dataset.method === 'Efectivo') card.classList.add('active');
    else card.classList.remove('active');
  });
  
  elements.cashPaymentFields.classList.remove('hidden');
  elements.cashReceived.value = '';
  updateChangeDisplay();
  
  if (elements.checkoutModal) elements.checkoutModal.showModal();
});

// Select payment method
elements.paymentMethodCards.forEach(card => {
  card.addEventListener('click', () => {
    elements.paymentMethodCards.forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    currentSalePaymentMethod = card.dataset.method;
    
    if (currentSalePaymentMethod === 'Efectivo') {
      elements.cashPaymentFields.classList.remove('hidden');
    } else {
      elements.cashPaymentFields.classList.add('hidden');
    }
  });
});

// Live Change Estimator
elements.cashReceived.addEventListener('input', updateChangeDisplay);

function updateChangeDisplay() {
  const totalVal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const receivedVal = Number(elements.cashReceived.value) || 0;
  
  if (elements.cashReceived.value.trim() === '') {
    elements.checkoutChangeDisplay.className = 'neutral-change';
    elements.checkoutChangeDisplay.textContent = '$0.00';
    return;
  }
  
  const changeVal = receivedVal - totalVal;
  
  if (changeVal >= 0) {
    elements.checkoutChangeDisplay.className = 'valid-change';
    elements.checkoutChangeDisplay.textContent = `$${changeVal.toFixed(2)}`;
  } else {
    elements.checkoutChangeDisplay.className = 'invalid-change';
    elements.checkoutChangeDisplay.textContent = `Pendiente: $${Math.abs(changeVal).toFixed(2)}`;
  }
}

// Quick Cash Buttons
elements.quickCashBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const amount = Number(btn.dataset.amount);
    const currentReceived = Number(elements.cashReceived.value) || 0;
    elements.cashReceived.value = (currentReceived + amount).toString();
    updateChangeDisplay();
  });
});

elements.quickCashExact.addEventListener('click', () => {
  const totalVal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  elements.cashReceived.value = totalVal.toFixed(2);
  updateChangeDisplay();
});

// Close Modals
elements.closeCheckoutBtn.addEventListener('click', closeCheckoutModal);
elements.cancelCheckoutBtn.addEventListener('click', closeCheckoutModal);

function closeCheckoutModal() {
  if (elements.checkoutModal) elements.checkoutModal.close();
}

// Complete Sale Action (Atomic Transaction in Firebase with Offline Fallback)
elements.completeSaleBtn.addEventListener('click', async () => {
  const totalVal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const totalCost = cart.reduce((sum, item) => sum + ((item.cost || 0) * item.quantity), 0);
  const totalProfit = totalVal - totalCost;
  
  if (currentSalePaymentMethod === 'Efectivo') {
    const receivedVal = Number(elements.cashReceived.value) || 0;
    if (receivedVal < totalVal) {
      showToast('El dinero en efectivo recibido es menor al total a cobrar.', 'warning');
      return;
    }
  }

  showLoading(true, 'Registrando venta...');
  elements.completeSaleBtn.disabled = true;

  const saleDoc = {
    items: cart.map(item => ({
      id: item.id,
      name: item.name,
      price: item.price,
      cost: item.cost,
      quantity: item.quantity
    })),
    total: totalVal,
    profit: totalProfit,
    paymentMethod: currentSalePaymentMethod,
    createdAt: Timestamp.now()
  };

  // Helper to complete sale locally in Firestore cache (offline mode)
  async function completeSaleOfflineFallback() {
    console.log("Ejecutando registro de venta en modo Offline (local writes)...");
    
    // We write the sale directly to the sales collection
    const saleRef = doc(collection(db, 'sales'));
    await setDoc(saleRef, saleDoc);
    
    // We update the product stocks directly via setDoc with merge
    for (const item of cart) {
      const product = products.find(p => p.id === item.id);
      if (product) {
        const productRef = doc(db, 'products', item.id);
        const newStock = Math.max(0, product.stock - item.quantity);
        await setDoc(productRef, {
          stock: newStock,
          updatedAt: Timestamp.now()
        }, { merge: true });
      }
    }
  }

  try {
    if (navigator.onLine) {
      // RUN FIREBASE TRANSACTION:
      // Ensures concurrent safety and atomic database writes. Stock levels decrement dynamically.
      await runTransaction(db, async (transaction) => {
        // 1. First get all products to verify and lock their states
        const productDocs = [];
        for (const item of cart) {
          const productRef = doc(db, 'products', item.id);
          const pDoc = await transaction.get(productRef);
          
          if (!pDoc.exists()) {
            throw new Error(`El producto "${item.name}" ya no existe en el sistema.`);
          }
          
          const dbStock = pDoc.data().stock || 0;
          if (dbStock < item.quantity) {
            throw new Error(`Stock insuficiente para "${item.name}". Disponible: ${dbStock}`);
          }
          
          productDocs.push({ ref: productRef, dbStock, quantity: item.quantity });
        }

        // 2. Queue sales record insertion
        const saleRef = doc(collection(db, 'sales'));
        transaction.set(saleRef, saleDoc);

        // 3. Queue stock updates
        for (const p of productDocs) {
          transaction.update(p.ref, {
            stock: p.dbStock - p.quantity,
            updatedAt: Timestamp.now()
          });
        }
      });

      // Transaction Success
      showToast('¡Venta realizada con éxito! (Online)', 'success');
    } else {
      // Offline fallback
      await completeSaleOfflineFallback();
      showToast('¡Venta registrada localmente! Se sincronizará automáticamente al detectar conexión.', 'success');
    }

    // Common success actions
    cart = [];
    updateCartUI();
    closeCheckoutModal();
    renderPOSProducts();
    
  } catch (err) {
    console.error("Sale processing failed:", err);
    // If transaction failed due to network or if we got an offline error, retry offline fallback
    if (err.message.includes('offline') || err.code === 'unavailable' || err.code === 'failed-precondition' || !navigator.onLine) {
      try {
        await completeSaleOfflineFallback();
        showToast('¡Venta registrada localmente (Offline)! Se sincronizará automáticamente.', 'success');
        cart = [];
        updateCartUI();
        closeCheckoutModal();
        renderPOSProducts();
      } catch (fallbackErr) {
        console.error("Offline fallback failed too:", fallbackErr);
        showToast(`Error al procesar venta offline: ${fallbackErr.message}`, 'error');
      }
    } else {
      showToast(`Error al procesar la venta: ${err.message}`, 'error');
    }
  } finally {
    showLoading(false);
    elements.completeSaleBtn.disabled = false;
  }
});

// ==========================================
// Inventario Module (Gestión CRUD)
// ==========================================
elements.addProductBtn.addEventListener('click', () => {
  elements.productForm.reset();
  elements.productId.value = '';
  elements.productModalTitle.textContent = 'Agregar Producto';
  resetImageUploadUI();
  if (elements.productModal) elements.productModal.showModal();
});

// Search in inventory list
elements.inventorySearch.addEventListener('input', (e) => {
  searchQueryParams.inventory = e.target.value.toLowerCase().trim();
  renderInventory();
});

// Render Inventory List View
function renderInventory() {
  const query = searchQueryParams.inventory;
  
  const filtered = products.filter(p => {
    return p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    elements.inventoryList.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">inventory</span>
        <p>${products.length === 0 ? 'No hay productos. Crea uno nuevo.' : 'Ningún producto coincide con el filtro.'}</p>
      </div>
    `;
    return;
  }

  elements.inventoryList.innerHTML = filtered.map(p => {
    let stockClass = 'inventory-card-stock';
    if (p.stock === 0) stockClass += ' danger';
    else if (p.stock <= 5) stockClass += ' warning';

    return `
      <div class="inventory-card">
        <div class="inventory-card-main-info">
          ${p.image ? `<img src="${p.image}" class="inventory-card-thumb" alt="${escapeHtml(p.name)}">` : `
          <div class="inventory-card-thumb-placeholder">
            <span class="material-icons">image</span>
          </div>
          `}
          <div class="inventory-card-details">
            <span class="inventory-card-name">${escapeHtml(p.name)}</span>
            <div class="inventory-card-metadata">
              <span class="inventory-card-meta-item">
                <span class="material-icons">sell</span>
                Precio: $${Number(p.price).toFixed(2)}
              </span>
              <span class="inventory-card-meta-item">
                <span class="material-icons">monetization_on</span>
                Costo: $${Number(p.cost || 0).toFixed(2)}
              </span>
              <span class="inventory-card-meta-item">
                <span class="material-icons">category</span>
                Cat: ${escapeHtml(p.category)}
              </span>
              ${p.barcode ? `
              <span class="inventory-card-meta-item">
                <span class="material-icons">qr_code</span>
                ${escapeHtml(p.barcode)}
              </span>
              ` : ''}
            </div>
          </div>
        </div>
        
        <div class="inventory-card-actions">
          <span class="${stockClass}">${p.stock} pz</span>
          ${authUserRole === 'admin' ? `
          <button class="btn-icon" onclick="window.openEditProductModal('${p.id}')">
            <span class="material-icons" style="color:var(--primary-light)">edit</span>
          </button>
          <button class="btn-icon" onclick="window.deleteProduct('${p.id}', '${escapeHtml(p.name)}')">
            <span class="material-icons" style="color:var(--danger)">delete</span>
          </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// Edit Modal Opening
window.openEditProductModal = (productId) => {
  const p = products.find(prod => prod.id === productId);
  if (!p) return;

  elements.productId.value = p.id;
  elements.prodName.value = p.name;
  elements.prodPrice.value = p.price;
  elements.prodCost.value = p.cost || 0;
  elements.prodStock.value = p.stock;
  
  // Make sure current category exists in select, otherwise add it as legacy option
  let selectEl = elements.prodCategory;
  if (selectEl) {
    let exists = Array.from(selectEl.options).some(opt => opt.value === p.category);
    if (!exists && p.category) {
      let opt = document.createElement('option');
      opt.value = p.category;
      opt.textContent = p.category + " (Histórica)";
      selectEl.appendChild(opt);
    }
    selectEl.value = p.category;
  }
  
  elements.prodBarcode.value = p.barcode || '';
  
  if (p.image) {
    currentProductImageBase64 = p.image;
    elements.prodImagePreview.src = p.image;
    elements.prodImagePreview.classList.remove('hidden');
    elements.imagePreviewPlaceholder.classList.add('hidden');
    elements.removeImageBtn.classList.remove('hidden');
  } else {
    resetImageUploadUI();
  }

  elements.productModalTitle.textContent = 'Editar Producto';
  if (elements.productModal) elements.productModal.showModal();
};

// Delete Product Action
window.deleteProduct = async (productId, name) => {
  if (confirm(`¿Seguro que deseas eliminar el producto "${name}"? Esta acción no se puede deshacer.`)) {
    showLoading(true, 'Eliminando producto...');
    try {
      // Let's also check if it exists in the active cart
      cart = cart.filter(item => item.id !== productId);
      updateCartUI();

      await deleteDoc(doc(db, 'products', productId));
      showToast('Producto eliminado correctamente.', 'success');
    } catch (err) {
      console.error("Delete failed:", err);
      showToast('Error al eliminar producto.', 'error');
    } finally {
      showLoading(false);
    }
  }
};

// Submit Add/Edit Product form
elements.productForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const id = elements.productId.value;
  const name = elements.prodName.value.trim();
  const price = Number(elements.prodPrice.value);
  const cost = Number(elements.prodCost.value) || 0;
  const stock = Number(elements.prodStock.value);
  const category = elements.prodCategory.value.trim();
  const barcode = elements.prodBarcode.value.trim();

  showLoading(true, 'Guardando producto...');
  
  const productData = {
    name,
    price,
    cost,
    stock,
    category,
    barcode,
    image: currentProductImageBase64 || '',
    updatedAt: Timestamp.now()
  };

  try {
    if (id) {
      // Update
      await setDoc(doc(db, 'products', id), productData, { merge: true });
      showToast('Producto actualizado.', 'success');
    } else {
      // Add
      await addDoc(collection(db, 'products'), productData);
      showToast('Producto registrado con éxito.', 'success');
    }
    closeProductModal();
  } catch (err) {
    console.error("Save product error:", err);
    showToast('Error al guardar producto.', 'error');
  } finally {
    showLoading(false);
  }
});

// Close Product Modal
elements.closeProductBtn.addEventListener('click', closeProductModal);
elements.cancelProductBtn.addEventListener('click', closeProductModal);

function closeProductModal() {
  if (elements.productModal) elements.productModal.close();
  resetImageUploadUI();
}

// ==========================================
// Historial & Reports Module
// ==========================================
elements.historyDateFilter.addEventListener('change', handleHistoryDateFilterChange);

function handleHistoryDateFilterChange() {
  renderHistoryList();
  updateDashboardMetrics();
}

// Get sales filtered by selection
function getFilteredSales() {
  const filterVal = elements.historyDateFilter.value;
  const now = new Date();
  
  let filterDate = new Date();
  filterDate.setHours(0,0,0,0);
  
  if (filterVal === 'yesterday') {
    filterDate.setDate(now.getDate() - 1);
    const startOfYesterday = new Date(filterDate);
    const endOfYesterday = new Date(filterDate);
    endOfYesterday.setHours(23, 59, 59, 999);
    
    return sales.filter(s => {
      const sDate = s.createdAt.toDate();
      return sDate >= startOfYesterday && sDate <= endOfYesterday;
    });
  }
  
  if (filterVal === '7days') {
    filterDate.setDate(now.getDate() - 7);
  } else if (filterVal === 'all') {
    return sales; // No date filter
  }
  
  // 'today' or '7days'
  return sales.filter(s => {
    const sDate = s.createdAt.toDate();
    return sDate >= filterDate;
  });
}

function updateDashboardMetrics() {
  const filteredSales = getFilteredSales();
  
  const revenue = filteredSales.reduce((sum, s) => sum + s.total, 0);
  const profit = filteredSales.reduce((sum, s) => sum + (s.profit || 0), 0);
  const count = filteredSales.length;

  elements.dashRevenue.textContent = `$${revenue.toFixed(2)}`;
  elements.dashProfit.textContent = `$${profit.toFixed(2)}`;
  elements.dashSalesCount.textContent = count;
}

function renderHistoryList() {
  const filteredSales = getFilteredSales();

  if (filteredSales.length === 0) {
    elements.historySalesList.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">receipt</span>
        <p>No se encontraron registros de ventas en este período.</p>
      </div>
    `;
    return;
  }

  elements.historySalesList.innerHTML = filteredSales.map(s => {
    const formattedTime = formatTime(s.createdAt.toDate());
    
    return `
      <div class="sale-card" id="sale-${s.id}">
        <div class="sale-card-header" onclick="window.toggleSaleDetails('${s.id}')">
          <div class="sale-card-summary">
            <span class="sale-card-time">${formattedTime}</span>
            <div class="sale-card-meta">
              <span class="sale-card-method">${s.paymentMethod}</span>
              <span>${s.items.reduce((sum, i) => sum + i.quantity, 0)} pz</span>
            </div>
          </div>
          <div class="sale-card-value">
            <span class="sale-card-total">$${s.total.toFixed(2)}</span>
            <span class="sale-card-profit">Gana: $${(s.profit || 0).toFixed(2)}</span>
          </div>
        </div>
        
        <div class="sale-card-details hidden" id="sale-details-${s.id}">
          ${s.items.map(item => `
            <div class="sale-detail-item">
              <div>
                <span class="sale-detail-qty">${item.quantity}x</span>
                <span>${escapeHtml(item.name)}</span>
              </div>
              <span>$${(item.price * item.quantity).toFixed(2)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

window.toggleSaleDetails = (saleId) => {
  const detailsEl = document.getElementById(`sale-details-${saleId}`);
  if (detailsEl) {
    detailsEl.classList.toggle('hidden');
  }
};

// ==========================================
// Subview Toggles & Navigation
// ==========================================
document.querySelectorAll('[data-subview]').forEach(btn => {
  btn.addEventListener('click', () => {
    const subview = btn.dataset.subview;
    const container = btn.closest('.inventory-container') || btn.closest('.history-container');
    
    // Update button states
    container.querySelectorAll('.view-toggle .toggle-btn').forEach(b => {
      if (b.dataset.subview === subview) b.classList.add('active');
      else b.classList.remove('active');
    });
    
    // Toggle containers
    container.querySelectorAll('.subview-content').forEach(el => {
      if (el.id === `${subview}-subview`) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    });

    // Run view updates
    if (subview === 'users') {
      renderUsers();
    } else if (subview === 'categories') {
      renderCategories();
    } else if (subview === 'reports') {
      renderProductSalesReport();
    }
  });
});

// ==========================================
// User Management Controller
// ==========================================
elements.addUserBtn.addEventListener('click', () => {
  elements.userForm.reset();
  if (elements.userModal) elements.userModal.showModal();
});

elements.closeUserBtn.addEventListener('click', closeUserModal);
elements.cancelUserBtn.addEventListener('click', closeUserModal);

function closeUserModal() {
  if (elements.userModal) elements.userModal.close();
}

// Render Users List
function renderUsers() {
  if (users.length === 0) {
    elements.usersList.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">people_outline</span>
        <p>No hay usuarios registrados.</p>
      </div>
    `;
    return;
  }

  elements.usersList.innerHTML = users.map(u => `
    <div class="user-card">
      <div class="user-card-info">
        <div class="user-card-icon">
          <span class="material-icons">person</span>
        </div>
        <div class="user-card-name-wrapper">
          <span class="user-card-name">${escapeHtml(u.username)}</span>
          <span class="user-card-role">${u.role === 'admin' ? 'Administrador' : 'Cajero / Operador'}</span>
        </div>
      </div>
      <span class="user-card-role">${u.role || 'usuario'}</span>
    </div>
  `).join('');
}

// Handle User Creation
elements.userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = elements.userUsername.value.trim().toLowerCase();
  const password = elements.userPassword.value;
  const role = elements.userRole.value;

  if (password.length < 4) {
    showToast('La contraseña debe tener mínimo 4 caracteres.', 'warning');
    return;
  }

  // Double check admin privileges
  if (authUser && authUser.email.split('@')[0] !== 'admin') {
    showToast('Solo el administrador principal puede crear usuarios.', 'error');
    return;
  }

  showLoading(true, 'Creando credenciales en Firebase...');
  const { email, password: securePassword } = formatAuthCredentials(username, password);

  try {
    if (!secondaryAuth) {
      throw new Error("El sistema secundario de credenciales de Firebase no está inicializado.");
    }
    
    // Register the user credentials using the secondary app instance
    // This creates the user in Firebase Auth without overriding the administrator's logged-in session!
    const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, securePassword);
    const newUser = userCredential.user;
    await secondaryAuth.signOut(); // Clean secondary state immediately

    // Save in Firestore collection to let us list it in the panel
    await setDoc(doc(db, 'users', newUser.uid), {
      username: username,
      role: role,
      createdAt: Timestamp.now()
    });

    showToast(`Usuario "${username}" creado exitosamente.`, 'success');
    closeUserModal();
    elements.userForm.reset();
  } catch (err) {
    console.error("Create User Error:", err);
    let msg = 'Error al registrar el usuario.';
    if (err.code === 'auth/email-already-in-use') {
      msg = 'El nombre de usuario ya está en uso.';
    } else if (err.code === 'auth/invalid-email') {
      msg = 'El nombre de usuario contiene caracteres inválidos.';
    } else if (err.code === 'auth/weak-password') {
      msg = 'La contraseña es muy débil.';
    }
    showToast(msg, 'error');
  } finally {
    showLoading(false);
  }
});

// Auto-migrate unique product categories to the 'categories' collection if empty
async function migrateCategoriesIfNeeded(productsList) {
  try {
    const catsSnapshot = await getDocs(collection(db, 'categories'));
    if (catsSnapshot.empty) {
      console.log("Migrando categorías existentes...");
      const uniqueCategories = [...new Set(productsList.map(p => p.category.trim()).filter(c => c !== ''))];
      for (const catName of uniqueCategories) {
        await addDoc(collection(db, 'categories'), {
          name: catName,
          createdAt: Timestamp.now()
        });
      }
      console.log("Migración de categorías completada.");
    }
  } catch (err) {
    console.warn("No se pudieron migrar las categorías:", err.message);
  }
}

// Update the select dropdown in the product add/edit form
function updateProductCategoryDropdown() {
  const selectEl = elements.prodCategory;
  if (!selectEl) return;

  const currentVal = selectEl.value;
  
  // Compile unique categories from products as fallback
  const productCats = [...new Set(products.map(p => p.category.trim()).filter(c => c !== ''))];
  const definedCats = categories.map(cat => cat.name.trim());
  const allUniqueCats = [...new Set([...definedCats, ...productCats])];
  
  // Clear and update options
  selectEl.innerHTML = allUniqueCats.map(catName => `
    <option value="${escapeHtml(catName)}">${escapeHtml(catName)}</option>
  `).join('');

  // If still no categories, show default generic categories so they can save products immediately
  if (allUniqueCats.length === 0) {
    selectEl.innerHTML = `
      <option value="General">General</option>
      <option value="Pasteles">Pasteles</option>
      <option value="Bebidas">Bebidas</option>
    `;
  }

  // Restore value if existed, otherwise select first option
  if (currentVal && allUniqueCats.includes(currentVal)) {
    selectEl.value = currentVal;
  }
}

// ==========================================
// Category Management Controller
// ==========================================
if (elements.addCategoryBtn) {
  elements.addCategoryBtn.addEventListener('click', () => {
    if (elements.categoryForm) elements.categoryForm.reset();
    if (elements.categoryId) elements.categoryId.value = '';
    elements.categoryModalTitle = document.getElementById('category-modal-title');
    if (elements.categoryModalTitle) elements.categoryModalTitle.textContent = 'Nueva Categoría';
    if (elements.categoryModal) elements.categoryModal.showModal();
  });
}

if (elements.closeCategoryBtn) elements.closeCategoryBtn.addEventListener('click', closeCategoryModal);
if (elements.cancelCategoryBtn) elements.cancelCategoryBtn.addEventListener('click', closeCategoryModal);

function closeCategoryModal() {
  if (elements.categoryModal) elements.categoryModal.close();
}

// Render Categories List
function renderCategories() {
  if (categories.length === 0) {
    elements.categoriesList.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">category</span>
        <p>No hay categorías registradas.</p>
      </div>
    `;
    return;
  }

  elements.categoriesList.innerHTML = categories.map(c => `
    <div class="user-card">
      <div class="user-card-info">
        <div class="user-card-icon" style="background: var(--primary-glow); color: var(--primary-light);">
          <span class="material-icons">category</span>
        </div>
        <div class="user-card-name-wrapper">
          <span class="user-card-name">${escapeHtml(c.name)}</span>
        </div>
      </div>
      ${authUserRole === 'admin' ? `
      <div style="display: flex; gap: 8px;">
        <button class="btn-icon" onclick="window.openEditCategoryModal('${c.id}')">
          <span class="material-icons" style="color:var(--primary-light)">edit</span>
        </button>
        <button class="btn-icon" onclick="window.deleteCategory('${c.id}', '${escapeHtml(c.name)}')">
          <span class="material-icons" style="color:var(--danger)">delete</span>
        </button>
      </div>
      ` : ''}
    </div>
  `).join('');
}

// Open Edit Category Modal
window.openEditCategoryModal = (catId) => {
  const c = categories.find(cat => cat.id === catId);
  if (!c) return;

  elements.categoryId.value = c.id;
  elements.categoryName.value = c.name;
  
  elements.categoryModalTitle = document.getElementById('category-modal-title');
  if (elements.categoryModalTitle) elements.categoryModalTitle.textContent = 'Editar Categoría';
  if (elements.categoryModal) elements.categoryModal.showModal();
};

// Delete Category
window.deleteCategory = async (catId, name) => {
  if (confirm(`¿Seguro que deseas eliminar la categoría "${name}"? Los productos que la usan no se eliminarán.`)) {
    showLoading(true, 'Eliminando categoría...');
    try {
      await deleteDoc(doc(db, 'categories', catId));
      showToast('Categoría eliminada.', 'success');
    } catch (err) {
      console.error("Delete category failed:", err);
      showToast('Error al eliminar categoría.', 'error');
    } finally {
      showLoading(false);
    }
  }
};

// Handle Category Form Submission
if (elements.categoryForm) {
  elements.categoryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = elements.categoryId ? elements.categoryId.value : '';
    const name = elements.categoryName ? elements.categoryName.value.trim() : '';

    showLoading(true, 'Guardando categoría...');
    
    const categoryData = {
      name,
      createdAt: Timestamp.now()
    };

    try {
      if (id) {
        // Update
        await setDoc(doc(db, 'categories', id), categoryData, { merge: true });
        showToast('Categoría actualizada.', 'success');
      } else {
        // Add
        await addDoc(collection(db, 'categories'), categoryData);
        showToast('Categoría creada exitosamente.', 'success');
      }
      closeCategoryModal();
    } catch (err) {
      console.error("Save category error:", err);
      showToast('Error al guardar categoría.', 'error');
    } finally {
      showLoading(false);
    }
  });
}

// ==========================================
// Product Sales Report Controller
// ==========================================
function renderProductSalesReport() {
  const filteredSales = getFilteredSales();

  // 1. Group products by quantity sold
  const productSalesMap = {};
  filteredSales.forEach(sale => {
    sale.items.forEach(item => {
      if (!productSalesMap[item.name]) {
        productSalesMap[item.name] = {
          name: item.name,
          quantity: 0,
          revenue: 0,
          cost: 0,
          profit: 0
        };
      }
      productSalesMap[item.name].quantity += item.quantity;
      productSalesMap[item.name].revenue += item.price * item.quantity;
      const itemCost = Number(item.cost || 0);
      productSalesMap[item.name].cost += itemCost * item.quantity;
      productSalesMap[item.name].profit += (item.price - itemCost) * item.quantity;
    });
  });

  // 2. Convert to array and sort by quantity descending
  const reportData = Object.values(productSalesMap);
  reportData.sort((a, b) => b.quantity - a.quantity);

  if (reportData.length === 0) {
    elements.reportsProductsList.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">bar_chart</span>
        <p>No hay productos vendidos en este período.</p>
      </div>
    `;
    return;
  }

  // 3. Render list with relative progress bars
  const maxQty = reportData[0].quantity || 1;
  
  elements.reportsProductsList.innerHTML = reportData.map(item => {
    const percentage = Math.max(5, (item.quantity / maxQty) * 100);
    return `
      <div class="report-product-card">
        <div class="report-product-main">
          <span class="report-product-name">${escapeHtml(item.name)}</span>
          <div class="report-product-stats">
            <span class="report-product-qty">${item.quantity} unidades</span>
            <span class="report-product-revenue" style="color:var(--text-secondary)">Cobrado: $${item.revenue.toFixed(2)}</span>
            <span class="report-product-profit" style="color:var(--success); font-weight: 600;">Ganancia: $${item.profit.toFixed(2)}</span>
          </div>
        </div>
        <div class="report-product-bar-wrapper">
          <div class="report-product-bar" style="width: ${percentage}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ==========================================
// Helper Utility Functions
// ==========================================
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  
  return `${day}/${month} ${hours}:${minutes}`;
}
