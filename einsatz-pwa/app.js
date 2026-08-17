// ============================================================
// Feuerwehr-Kataster – Einsatz-PWA
// ============================================================

const COLORS = {
  teal:  { marker: '#0F6E56', ring: '#5DCAA5', dark: '#04342C' },
  coral: { marker: '#993C1D', ring: '#E0A088', dark: '#4A1B0C' },
  gray:  { marker: '#5F5E5A', ring: '#C9C7BE', dark: '#2C2C2A' },
  blue:  { marker: '#378ADD', ring: '#A8CDEF', dark: '#1C4A73' },
};

let map, markersLayer, categories = [];
let categoryCursor = { teal: -1, coral: -1, gray: -1 };
let initialFitDone = false;
let pendingClickLatLng = null;
let editingPointId = null;
let placementMode = false;
let tempMarker = null;

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
    throw new Error(body.error || ('Serverfehler (Status ' + res.status + ')'));
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
  document.getElementById('wehr-title').textContent = localStorage.getItem('wehrname_cache') || 'Feuerwehr-Kataster';
  api('/api/settings')
    .then((s) => {
      document.getElementById('wehr-title').textContent = s.wehrname;
      localStorage.setItem('wehrname_cache', s.wehrname); // fürs nächste Mal, auch offline
      if (s.overdue_months) OVERDUE_MONTHS = s.overdue_months;
      renderPoints();
      renderMobileList();
    })
    .catch(() => {});

  api('/api/system-status')
    .then((s) => {
      const banner = document.getElementById('disk-warning');
      if (s.warning && sessionStorage.getItem('disk-warning-dismissed') !== 'true') {
        document.getElementById('disk-warning-percent').textContent = s.disk_percent ? ` (${s.disk_percent}% belegt)` : '';
        banner.classList.add('show');
      }
    })
    .catch(() => {});

  initMapIfNeeded();
  loadCategories().then(loadPoints);
}

document.getElementById('disk-warning-dismiss').addEventListener('click', () => {
  document.getElementById('disk-warning').classList.remove('show');
  sessionStorage.setItem('disk-warning-dismissed', 'true'); // erscheint bei nächster Anmeldung wieder
});

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
  map = L.map('map', { zoomControl: true }).setView([51.1657, 10.4515], 6); // Deutschland-Übersicht, wird nach dem Laden der Punkte automatisch angepasst

  L.tileLayer('/tiles/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap-Mitwirkende',
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    if (placementMode) {
      pendingClickLatLng = e.latlng;
      placeTempMarker(e.latlng);
      placementMode = false;
      document.getElementById('placement-banner').classList.remove('show');
      openForm(null); // Formular erscheint erst jetzt, mit bereits gesetzter Position
      return;
    }
    if (document.getElementById('form-overlay').classList.contains('open')) {
      pendingClickLatLng = e.latlng;
      placeTempMarker(e.latlng);
      document.getElementById('form-coords').textContent =
        e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5);
    }
  });
}

function placeTempMarker(latlng) {
  if (tempMarker) map.removeLayer(tempMarker);
  tempMarker = L.marker(latlng, { icon: pinIcon('blue', true), draggable: true }).addTo(map);
  tempMarker.on('dragend', () => {
    const pos = tempMarker.getLatLng();
    pendingClickLatLng = pos;
    document.getElementById('form-coords').textContent = pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5);
  });
}

function clearTempMarker() {
  if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
}

let OVERDUE_MONTHS = 12; // Vorgabe, wird beim Laden durch den Wert aus den Einstellungen ersetzt

function isOverdue(point) {
  if (!point.last_checked) return true; // noch nie geprüft
  const checked = new Date(point.last_checked);
  const limit = new Date();
  limit.setMonth(limit.getMonth() - OVERDUE_MONTHS);
  return checked < limit;
}

function pinIcon(colorKey, selected, overdue) {
  const c = COLORS[colorKey] || COLORS.gray;
  const size = selected ? 30 : 22;
  const warningDot = overdue
    ? `<div style="position:absolute; top:-2px; right:-2px; width:10px; height:10px; border-radius:50%;
                   background:#993C1D; border:1.5px solid white;"></div>`
    : '';
  const html = `
    <div style="position:relative; width:${size}px; height:${size}px;">
      <div style="width:${size}px;height:${size}px;border-radius:50%;
                  background:${c.marker}; border:2px solid ${c.dark};
                  display:flex;align-items:center;justify-content:center;
                  box-shadow:0 1px 3px rgba(0,0,0,0.35);">
      </div>
      ${warningDot}
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
  renderMobileList();

  if (!initialFitDone && allPoints.length && map) {
    initialFitDone = true;
    const bounds = L.latLngBounds(allPoints.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function renderPoints() {
  markersLayer.clearLayers();
  allPoints
    .filter((p) => p.id !== editingPointId)
    .forEach((p) => {
      const marker = L.marker([p.lat, p.lng], { icon: pinIcon(p.category_color, false, isOverdue(p)) });
      marker.on('click', () => openSheet(p));
      marker.addTo(markersLayer);
    });
}

function renderMobileList() {
  const container = document.getElementById('mobile-point-list');
  if (!container) return;

  if (!allPoints.length) {
    container.innerHTML = '<div id="list-empty">Noch keine Punkte erfasst.</div>';
    return;
  }

  container.innerHTML = allPoints
    .map(
      (p) => `
      <div class="mobile-point-row" data-id="${p.id}">
        <span class="dot ${p.category_color}"></span>
        <div class="info">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="meta">${escapeHtml(p.category_label)}${p.capacity_liters ? ' · ' + Number(p.capacity_liters).toLocaleString('de-DE') + ' L' : ''}</div>
        </div>
        ${isOverdue(p) ? '<span class="overdue-badge" title="Prüfung überfällig">⚠️</span>' : ''}
      </div>`
    )
    .join('');

  container.querySelectorAll('.mobile-point-row').forEach((row) => {
    row.addEventListener('click', () => {
      const point = allPoints.find((p) => p.id === Number(row.dataset.id));
      if (!point) return;
      document.querySelector('.nav-btn[data-view="map"]').click();
      map.setView([point.lat, point.lng], 17);
      openSheet(point);
    });
  });
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const color = chip.dataset.color;
    const matches = allPoints.filter((p) => p.category_color === color);
    if (!matches.length) {
      alert('Für diese Kategorie sind noch keine Punkte erfasst.');
      return;
    }
    categoryCursor[color] = (categoryCursor[color] + 1) % matches.length;
    const point = matches[categoryCursor[color]];

    document.querySelector('.nav-btn[data-view="map"]').click();
    map.setView([point.lat, point.lng], 17);
    openSheet(point);
  });
});

// ============================================================
// Bottom-Navigation (Karte / Liste)
// ============================================================
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    document.getElementById('view-map').classList.toggle('active', view === 'map');
    document.getElementById('view-list').classList.toggle('active', view === 'list');
    document.getElementById('view-settings').classList.toggle('active', view === 'settings');
    if (view === 'list') {
      renderMobileList();
    } else if (view === 'settings') {
      loadSettingsView();
    } else if (map) {
      // Leaflet braucht nach dem Wiedereinblenden einen Hinweis zur tatsächlichen Größe
      setTimeout(() => map.invalidateSize(), 50);
    }
  });
});

// ============================================================
// Detail-Sheet
// ============================================================
let currentSheetPoint = null;

function openSheet(p) {
  if (document.getElementById('form-overlay').classList.contains('open')) {
    document.getElementById('form-overlay').classList.remove('open');
    clearTempMarker();
    editingPointId = null;
    renderPoints();
  }

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

  const photoEl = document.getElementById('sheet-photo');
  if (p.photo_url) {
    photoEl.src = p.photo_url;
    photoEl.style.display = 'block';
  } else {
    photoEl.style.display = 'none';
  }

  document.getElementById('sheet-overdue-warning').style.display = isOverdue(p) ? 'block' : 'none';

  document.getElementById('sheet').classList.add('open');
}

document.getElementById('sheet-close').addEventListener('click', () => {
  document.getElementById('sheet').classList.remove('open');
});

document.getElementById('sheet-route').addEventListener('click', () => {
  if (!currentSheetPoint) return;
  const url = `https://www.google.com/maps/dir/?api=1&destination=${currentSheetPoint.lat},${currentSheetPoint.lng}`;
  window.open(url, '_blank');
});

document.getElementById('sheet-edit').addEventListener('click', () => {
  if (!currentSheetPoint) return;
  openForm(currentSheetPoint);
  document.getElementById('sheet').classList.remove('open');
});

// ============================================================
// Änderungsverlauf
// ============================================================
const HISTORY_LABELS = {
  created: 'Angelegt',
  updated: 'Geändert',
  deleted: 'Gelöscht',
  photo_updated: 'Foto aktualisiert',
};

document.getElementById('sheet-history').addEventListener('click', async () => {
  if (!currentSheetPoint) return;
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<p class="hint">Lade Verlauf …</p>';
  document.getElementById('history-overlay').classList.add('open');

  try {
    const entries = await api(`/api/points/${currentSheetPoint.id}/history`);
    if (!entries.length) {
      listEl.innerHTML = '<p class="hint">Noch keine Einträge vorhanden.</p>';
      return;
    }
    listEl.innerHTML = entries
      .map((e) => {
        const when = new Date(e.changed_at).toLocaleString('de-DE');
        const who = e.username ? escapeHtml(e.username) : 'Unbekannt';
        const label = HISTORY_LABELS[e.change_type] || e.change_type;
        return `
          <div class="history-entry">
            <div class="type">${label}</div>
            <div class="meta">${when} · ${who}</div>
          </div>`;
      })
      .join('');
  } catch (err) {
    listEl.innerHTML = '<p class="hint">Verlauf konnte nicht geladen werden.</p>';
  }
});

document.getElementById('history-close').addEventListener('click', () => {
  document.getElementById('history-overlay').classList.remove('open');
});

// ============================================================
// Formular: Punkt anlegen / bearbeiten
// ============================================================
function openForm(point) {
  editingPointId = point ? point.id : null;
  if (point) {
    pendingClickLatLng = { lat: point.lat, lng: point.lng };
    renderPoints(); // blendet den bearbeiteten Punkt automatisch aus (editingPointId ist bereits gesetzt)
    placeTempMarker([point.lat, point.lng]);
  }
  // Wenn kein "point" übergeben wurde, bleibt eine bereits im Platzierungsschritt
  // gesetzte pendingClickLatLng erhalten statt überschrieben zu werden.

  document.getElementById('form-title').textContent = point ? 'Punkt bearbeiten' : 'Neuen Punkt anlegen';
  document.getElementById('form-coords').textContent = pendingClickLatLng
    ? pendingClickLatLng.lat.toFixed(5) + ', ' + pendingClickLatLng.lng.toFixed(5)
    : '– auf die Karte tippen –';

  document.getElementById('f-name').value = point?.name || '';
  document.getElementById('f-category').value = point?.category_id || (categories[0] && categories[0].id) || '';
  document.getElementById('f-capacity').value = point?.capacity_liters ?? '';
  document.getElementById('f-access').value = point?.accessibility || '';
  document.getElementById('f-condition').value = point?.condition_note || '';
  document.getElementById('f-owner').value = point?.owner_name || '';
  document.getElementById('f-phone').value = point?.owner_phone || '';
  document.getElementById('f-key').value = point?.key_deposit_note || '';
  document.getElementById('f-checked').value = point?.last_checked ? point.last_checked.substring(0, 10) : '';

  document.getElementById('f-photo').value = '';
  const preview = document.getElementById('f-photo-preview');
  if (point?.photo_url) {
    preview.src = point.photo_url;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }

  document.getElementById('form-overlay').classList.add('open');
  document.getElementById('point-form').scrollTop = 0;
}

function resizeImageToDataUrl(file, maxDim = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Bild konnte nicht gelesen werden.'));
    };
    img.src = url;
  });
}

document.getElementById('f-photo').addEventListener('change', async () => {
  const file = document.getElementById('f-photo').files[0];
  const preview = document.getElementById('f-photo-preview');
  if (!file) return;
  try {
    preview.src = await resizeImageToDataUrl(file);
    preview.style.display = 'block';
  } catch {
    alert('Foto konnte nicht gelesen werden, bitte ein anderes wählen.');
  }
});

document.getElementById('fab-add').addEventListener('click', () => {
  placementMode = true;
  editingPointId = null;
  pendingClickLatLng = null;
  clearTempMarker();
  document.getElementById('placement-banner').classList.add('show');
});

document.getElementById('placement-cancel').addEventListener('click', () => {
  placementMode = false;
  document.getElementById('placement-banner').classList.remove('show');
});

document.getElementById('form-cancel').addEventListener('click', () => {
  document.getElementById('form-overlay').classList.remove('open');
  clearTempMarker();
  editingPointId = null;
  renderPoints();
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
    capacity_liters: document.getElementById('f-capacity').value === '' ? null : Number(document.getElementById('f-capacity').value),
    accessibility: document.getElementById('f-access').value.trim() || null,
    condition_note: document.getElementById('f-condition').value.trim() || null,
    owner_name: document.getElementById('f-owner').value.trim() || null,
    owner_phone: document.getElementById('f-phone').value.trim() || null,
    key_deposit_note: document.getElementById('f-key').value.trim() || null,
    last_checked: document.getElementById('f-checked').value || null,
  };
  const photoFile = document.getElementById('f-photo').files[0];

  async function uploadPhotoIfAny(pointId) {
    if (!photoFile || !navigator.onLine) return;
    const base64 = document.getElementById('f-photo-preview').src; // bereits verkleinert beim Auswählen
    try {
      await api(`/api/points/${pointId}/photo`, { method: 'POST', body: JSON.stringify({ photo_base64: base64 }) });
    } catch (err) {
      alert('Punkt gespeichert, aber Foto-Upload ist fehlgeschlagen: ' + err.message);
    }
  }

  try {
    if (editingPointId) {
      await api('/api/points/' + editingPointId, { method: 'PUT', body: JSON.stringify(payload) });
      await uploadPhotoIfAny(editingPointId);
    } else if (navigator.onLine) {
      const created = await api('/api/points', { method: 'POST', body: JSON.stringify(payload) });
      await uploadPhotoIfAny(created.id);
    } else {
      await queuePoint(payload);
      alert('Kein Netz – der Punkt wurde lokal gespeichert und wird automatisch übertragen, sobald wieder Verbindung besteht.' +
        (photoFile ? ' Das Foto muss nach der Übertragung separat ergänzt werden.' : ''));
    }
    document.getElementById('form-overlay').classList.remove('open');
    clearTempMarker();
    editingPointId = null;
    loadPoints();
  } catch (err) {
    if (!navigator.onLine) {
      await queuePoint(payload);
      alert('Kein Netz – der Punkt wurde lokal gespeichert und wird automatisch übertragen, sobald wieder Verbindung besteht.');
      document.getElementById('form-overlay').classList.remove('open');
      clearTempMarker();
      editingPointId = null;
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
    } catch (err) {
      if (!navigator.onLine) break; // wirklich offline, später automatisch erneut versuchen

      // Verbindung besteht, aber der Server hat abgelehnt (z.B. ungültige Daten) -
      // nicht endlos im Hintergrund weiterversuchen, sondern den Nutzer informieren.
      alert(
        'Ein zwischengespeicherter Punkt ("' + (body.name || 'unbenannt') + '") konnte nicht übertragen werden: ' +
        err.message + '\nEr bleibt in der Warteschlange auf diesem Gerät.'
      );
      break;
    }
  }
  if (pending.length) loadPoints();
}

window.addEventListener('online', syncPendingPoints);

// ============================================================
// Einstellungen
// ============================================================
async function loadSettingsView() {
  const username = localStorage.getItem('username') || '–';
  const role = localStorage.getItem('role') === 'admin' ? 'Admin' : 'Gruppenführer';
  document.getElementById('settings-whoami').textContent = `${username} (${role})`;

  const isAdmin = localStorage.getItem('role') === 'admin';
  document.getElementById('wehrname-edit-btn').style.display = isAdmin ? 'inline-block' : 'none';

  try {
    const settings = await api('/api/settings');
    document.getElementById('wehrname-display').textContent = settings.wehrname;
    document.getElementById('s-overdue-months').value = settings.overdue_months;
  } catch {
    document.getElementById('wehrname-display').textContent = '–';
  }
}

document.getElementById('wehrname-edit-btn').addEventListener('click', () => {
  document.getElementById('s-wehrname').value = document.getElementById('wehrname-display').textContent;
  document.getElementById('wehrname-form').style.display = 'flex';
});
document.getElementById('wehrname-cancel').addEventListener('click', () => {
  document.getElementById('wehrname-form').style.display = 'none';
});
document.getElementById('wehrname-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const wehrname = document.getElementById('s-wehrname').value.trim();
  const overdue_months = Number(document.getElementById('s-overdue-months').value);
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ wehrname, overdue_months }) });
    document.getElementById('wehrname-display').textContent = wehrname;
    document.getElementById('wehrname-form').style.display = 'none';
    document.getElementById('wehr-title').textContent = wehrname;
    OVERDUE_MONTHS = overdue_months;
    renderPoints();
    renderMobileList();
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
});

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('password-error');
  errorEl.textContent = '';
  const pw1 = document.getElementById('s-new-password').value;
  const pw2 = document.getElementById('s-new-password-repeat').value;
  if (pw1 !== pw2) {
    errorEl.textContent = 'Die Passwörter stimmen nicht überein.';
    return;
  }
  if (pw1.length < 8) {
    errorEl.textContent = 'Das Passwort muss mindestens 8 Zeichen haben.';
    return;
  }
  try {
    await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ newPassword: pw1 }) });
    document.getElementById('password-form').reset();
    alert('Passwort wurde geändert.');
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  if (!confirm('Wirklich abmelden?')) return;
  clearSession();
  location.reload();
});

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

// ============================================================
// Formular-Höhe an die tatsächlich sichtbare Fläche koppeln
// (wichtig auf iOS: die Tastatur verkleinert den sichtbaren Bereich,
// ohne dass sich vh-Einheiten mitändern - sonst rutscht das unter der
// Tastatur "abgeschnittene" Formular außer Reichweite)
// ============================================================
if (window.visualViewport) {
  const adjustFormViewport = () => {
    const availablePx = Math.round(window.visualViewport.height * 0.92);
    ['point-form', 'sheet', 'history-panel'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.maxHeight = availablePx + 'px';
    });
  };
  window.visualViewport.addEventListener('resize', adjustFormViewport);
  window.visualViewport.addEventListener('scroll', adjustFormViewport);
  adjustFormViewport();
}
