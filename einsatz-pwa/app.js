// ============================================================
// Feuerwehr-Kataster – Einsatz-PWA
// ============================================================

const COLORS = {
  teal:  { marker: '#0F6E56', ring: '#5DCAA5', dark: '#04342C' },
  coral: { marker: '#993C1D', ring: '#E0A088', dark: '#4A1B0C' },
  gray:  { marker: '#5F5E5A', ring: '#C9C7BE', dark: '#2C2C2A' },
};

let map, markersLayer, categories = [], activeColors = new Set(['teal', 'coral', 'gray']);
let pendingClickLatLng = null;
let editingPointId = null;

// --- Hilfsfunktionen für Login/Token ---
function getToken() { return localStorage.getItem('token'); }
function setSession(token, role, username) {
  localStorage.setItem('token', token);
  localStorage.setItem('role', role);
  localStorage.setItem('username', username);
}
function clearSession() { localStorage.clear(); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    clearSession();
    showLogin();
    throw new Error('Sitzung abgelaufen');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Ein Fehler ist aufgetreten.');
  }
  return res.status === 204 ? null : res.json();
}

// ============================================================
// Login
// ============================================================
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('main-screen').style.display = 'none';
}

function showMain() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'flex';
  const wehrname = localStorage.getItem('wehrname') || 'Feuerwehr-Kataster';
  document.getElementById('wehr-title').textContent = wehrname;
  initMapIfNeeded();
  loadCategories().then(loadPoints);
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setSession(data.token, data.role, data.username);
    showMain();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ============================================================
// Karte
// ============================================================
function initMapIfNeeded() {
  if (map) return;
  map = L.map('map', { zoomControl: true }).setView([49.4875, 9.7735], 14); // Startpunkt: grob Region des Nutzers, wird angepasst

  L.tileLayer('/tiles/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap-Mitwirkende',
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    if (document.getElementById('form-overlay').classList.contains('open')) {
      pendingClickLatLng = e.latlng;
      document.getElementById('form-coords').textContent =
        e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5);
    }
  });
}

function pinIcon(colorKey, selected) {
  const c = COLORS[colorKey] || COLORS.gray;
  const size = selected ? 30 : 22;
  const html = `
    <div style="width:${size}px;height:${size}px;border-radius:50%;
                background:${c.marker}; border:2px solid ${c.dark};
                display:flex;align-items:center;justify-content:center;
                box-shadow:0 1px 3px rgba(0,0,0,0.35);">
    </div>`;
  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

async function loadCategories() {
  categories = await api('/api/categories');
  const select = document.getElementById('f-category');
  select.innerHTML = categories
    .map((c) => `<option value="${c.id}" data-color="${c.color}">${c.label}</option>`)
    .join('');
}

let allPoints = [];

async function loadPoints() {
  try {
    allPoints = await api('/api/points');
    document.getElementById('offline-badge').classList.remove('show');
  } catch (err) {
    document.getElementById('offline-badge').classList.add('show');
    // Bereits geladene / vom Service Worker gecachte Daten bleiben in allPoints erhalten
  }
  renderPoints();
}

function renderPoints() {
  markersLayer.clearLayers();
  allPoints
    .filter((p) => activeColors.has(p.category_color))
    .forEach((p) => {
      const marker = L.marker([p.lat, p.lng], { icon: pinIcon(p.category_color, false) });
      marker.on('click', () => openSheet(p));
      marker.addTo(markersLayer);
    });
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const color = chip.dataset.color;
    if (activeColors.has(color)) {
      activeColors.delete(color);
      chip.classList.remove('active');
    } else {
      activeColors.add(color);
      chip.classList.add('active');
    }
    renderPoints();
  });
});

// ============================================================
// Detail-Sheet
// ============================================================
let currentSheetPoint = null;

function openSheet(p) {
  currentSheetPoint = p;
  document.getElementById('sheet-title').textContent = p.name;
  document.getElementById('sheet-subtitle').textContent =
    (p.category_label || '') + (p.capacity_liters ? ' · ca. ' + Number(p.capacity_liters).toLocaleString('de-DE') + ' Liter' : '');
  document.getElementById('sheet-access').textContent = p.accessibility || '–';
  document.getElementById('sheet-condition').textContent = p.condition_note || '–';
  document.getElementById('sheet-owner').textContent = p.owner_name || '–';
  document.getElementById('sheet-checked').textContent = p.last_checked
    ? new Date(p.last_checked).toLocaleDateString('de-DE')
    : '–';
  document.getElementById('sheet').classList.add('open');
}

document.getElementById('sheet-close').addEventListener('click', () => {
  document.getElementById('sheet').classList.remove('open');
});

document.getElementById('sheet-route').addEventListener('click', () => {
  if (!currentSheetPoint) return;
  const url = `https://www.openstreetmap.org/directions?to=${currentSheetPoint.lat},${currentSheetPoint.lng}`;
  window.open(url, '_blank');
});

document.getElementById('sheet-edit').addEventListener('click', () => {
  if (!currentSheetPoint) return;
  openForm(currentSheetPoint);
  document.getElementById('sheet').classList.remove('open');
});

// ============================================================
// Formular: Punkt anlegen / bearbeiten
// ============================================================
function openForm(point) {
  editingPointId = point ? point.id : null;
  pendingClickLatLng = point ? { lat: point.lat, lng: point.lng } : null;

  document.getElementById('form-title').textContent = point ? 'Punkt bearbeiten' : 'Neuen Punkt anlegen';
  document.getElementById('form-coords').textContent = point
    ? point.lat.toFixed(5) + ', ' + point.lng.toFixed(5)
    : '– auf die Karte tippen –';

  document.getElementById('f-name').value = point?.name || '';
  document.getElementById('f-category').value = point?.category_id || (categories[0] && categories[0].id) || '';
  document.getElementById('f-capacity').value = point?.capacity_liters || '';
  document.getElementById('f-access').value = point?.accessibility || '';
  document.getElementById('f-condition').value = point?.condition_note || '';
  document.getElementById('f-owner').value = point?.owner_name || '';
  document.getElementById('f-phone').value = point?.owner_phone || '';
  document.getElementById('f-key').value = point?.key_deposit_note || '';
  document.getElementById('f-checked').value = point?.last_checked ? point.last_checked.substring(0, 10) : '';

  document.getElementById('form-overlay').classList.add('open');
}

document.getElementById('fab-add').addEventListener('click', () => openForm(null));
document.getElementById('form-cancel').addEventListener('click', () => {
  document.getElementById('form-overlay').classList.remove('open');
});

document.getElementById('point-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pendingClickLatLng) {
    alert('Bitte zuerst eine Position auf der Karte antippen.');
    return;
  }
  const categorySelect = document.getElementById('f-category');
  const payload = {
    name: document.getElementById('f-name').value.trim(),
    category_id: Number(categorySelect.value),
    lat: pendingClickLatLng.lat,
    lng: pendingClickLatLng.lng,
    capacity_liters: Number(document.getElementById('f-capacity').value) || null,
    accessibility: document.getElementById('f-access').value.trim() || null,
    condition_note: document.getElementById('f-condition').value.trim() || null,
    owner_name: document.getElementById('f-owner').value.trim() || null,
    owner_phone: document.getElementById('f-phone').value.trim() || null,
    key_deposit_note: document.getElementById('f-key').value.trim() || null,
    last_checked: document.getElementById('f-checked').value || null,
  };

  try {
    if (editingPointId) {
      await api('/api/points/' + editingPointId, { method: 'PUT', body: JSON.stringify(payload) });
    } else if (navigator.onLine) {
      await api('/api/points', { method: 'POST', body: JSON.stringify(payload) });
    } else {
      await queuePoint(payload);
      alert('Kein Netz – der Punkt wurde lokal gespeichert und wird automatisch übertragen, sobald wieder Verbindung besteht.');
    }
    document.getElementById('form-overlay').classList.remove('open');
    loadPoints();
  } catch (err) {
    if (!navigator.onLine) {
      await queuePoint(payload);
      alert('Kein Netz – der Punkt wurde lokal gespeichert und wird automatisch übertragen, sobald wieder Verbindung besteht.');
      document.getElementById('form-overlay').classList.remove('open');
    } else {
      alert('Fehler beim Speichern: ' + err.message);
    }
  }
});

// ============================================================
// Offline-Warteschlange (IndexedDB)
// ============================================================
function openQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kataster-queue', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('pending', { keyPath: 'localId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queuePoint(point) {
  const db = await openQueueDb();
  point.localId = Date.now() + '-' + Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').put(point);
    tx.oncomplete = () => resolve(point.localId);
    tx.onerror = () => reject(tx.error);
  });
}

async function getPendingPoints() {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readonly');
    const req = tx.objectStore('pending').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function removePendingPoint(localId) {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function syncPendingPoints() {
  const pending = await getPendingPoints();
  for (const p of pending) {
    const { localId, ...body } = p;
    try {
      await api('/api/points', { method: 'POST', body: JSON.stringify(body) });
      await removePendingPoint(localId);
    } catch {
      break; // noch keine Verbindung zum Server – später erneut versuchen
    }
  }
  if (pending.length) loadPoints();
}

window.addEventListener('online', syncPendingPoints);

// ============================================================
// Start
// ============================================================
if (getToken()) {
  showMain();
} else {
  showLogin();
}

if (navigator.onLine) syncPendingPoints();

// Service Worker registrieren (nur über HTTPS bzw. localhost verfügbar)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) =>
      console.warn('Service Worker konnte nicht registriert werden:', err)
    );
  });
}
