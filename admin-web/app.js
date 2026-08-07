// ============================================================
// Feuerwehr-Kataster – Verwaltungsoberfläche
// ============================================================

let map, markersLayer, categories = [], allPoints = [];
let selectedPoint = null;
let editingPointId = null;
let pendingClickLatLng = null;

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
    location.reload();
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
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setSession(data.token, data.role, data.username);
    startApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

function startApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').classList.add('visible');
  if (localStorage.getItem('role') === 'admin') {
    document.getElementById('user-admin').style.display = 'block';
  }
  initMap();
  loadCategories().then(loadPoints);
}

if (getToken()) startApp();

// ============================================================
// Karte
// ============================================================
function initMap() {
  map = L.map('map').setView([49.4875, 9.7735], 13);
  L.tileLayer('/tiles/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  map.on('click', (e) => {
    if (document.getElementById('form-overlay').classList.contains('open')) {
      pendingClickLatLng = e.latlng;
      placeTempMarker(e.latlng);
      document.getElementById('form-coords').textContent =
        e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5);
    }
  });
}

let tempMarker = null;

function placeTempMarker(latlng) {
  if (tempMarker) map.removeLayer(tempMarker);
  tempMarker = L.marker(latlng, { icon: pinIcon('blue', false, true), draggable: true }).addTo(map);
  tempMarker.on('dragend', () => {
    const pos = tempMarker.getLatLng();
    pendingClickLatLng = pos;
    document.getElementById('form-coords').textContent = pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5);
  });
}

function clearTempMarker() {
  if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
}

const COLORS = { teal: '#0F6E56', coral: '#993C1D', gray: '#5F5E5A', blue: '#378ADD' };
const OVERDUE_MONTHS = 12;

function isOverdue(point) {
  if (!point.last_checked) return true;
  const checked = new Date(point.last_checked);
  const limit = new Date();
  limit.setMonth(limit.getMonth() - OVERDUE_MONTHS);
  return checked < limit;
}

function pinIcon(colorKey, overdue, draggableLook) {
  const color = COLORS[colorKey] || COLORS.gray;
  const size = draggableLook ? 26 : 20;
  const warningDot = overdue
    ? `<div style="position:absolute; top:-2px; right:-2px; width:9px; height:9px; border-radius:50%; background:#993C1D; border:1.5px solid white;"></div>`
    : '';
  const html = `
    <div style="position:relative; width:${size}px; height:${size}px;">
      <div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid rgba(0,0,0,0.3);"></div>
      ${warningDot}
    </div>`;
  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

async function loadCategories() {
  categories = await api('/api/categories');
  const select = document.getElementById('f-category');
  select.innerHTML = categories.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
}

async function loadPoints() {
  allPoints = await api('/api/points');
  renderList();
  renderMarkers();
}

function renderList() {
  const list = document.getElementById('point-list');
  list.innerHTML = allPoints
    .map(
      (p) => `
      <div class="point-row" data-id="${p.id}">
        <span class="dot ${p.category_color}"></span>
        <div class="info">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="meta">${escapeHtml(p.category_label)}${p.capacity_liters ? ' · ' + Number(p.capacity_liters).toLocaleString('de-DE') + ' L' : ''}</div>
        </div>
        ${isOverdue(p) ? '<span class="overdue-badge" title="Prüfung überfällig">⚠️</span>' : ''}
      </div>`
    )
    .join('');
  list.querySelectorAll('.point-row').forEach((row) => {
    row.addEventListener('click', () => {
      const point = allPoints.find((p) => p.id === Number(row.dataset.id));
      if (point) {
        map.setView([point.lat, point.lng], 16);
        showDetail(point);
      }
    });
  });
}

function renderMarkers() {
  markersLayer.clearLayers();
  allPoints.forEach((p) => {
    const marker = L.marker([p.lat, p.lng], { icon: pinIcon(p.category_color, isOverdue(p)) });
    marker.on('click', () => showDetail(p));
    marker.addTo(markersLayer);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ============================================================
// Detailpanel
// ============================================================
function showDetail(p) {
  selectedPoint = p;
  document.getElementById('detail-title').textContent = p.name;
  document.getElementById('detail-category').textContent = p.category_label;
  document.getElementById('detail-capacity').textContent = p.capacity_liters ? Number(p.capacity_liters).toLocaleString('de-DE') + ' Liter' : '–';
  document.getElementById('detail-access').textContent = p.accessibility || '–';
  document.getElementById('detail-condition').textContent = p.condition_note || '–';
  document.getElementById('detail-owner').textContent = p.owner_name || '–';
  document.getElementById('detail-phone').textContent = p.owner_phone || '–';
  document.getElementById('detail-key').textContent = p.key_deposit_note || '–';
  document.getElementById('detail-checked').textContent = p.last_checked ? new Date(p.last_checked).toLocaleDateString('de-DE') : '–';

  const photoEl = document.getElementById('detail-photo');
  if (p.photo_url) {
    photoEl.src = p.photo_url;
    photoEl.style.display = 'block';
  } else {
    photoEl.style.display = 'none';
  }
  document.getElementById('detail-overdue-warning').style.display = isOverdue(p) ? 'block' : 'none';

  document.getElementById('detail-panel').classList.add('open');
  document.getElementById('detail-delete').style.display = localStorage.getItem('role') === 'admin' ? 'block' : 'none';
}

document.getElementById('detail-edit').addEventListener('click', () => {
  if (selectedPoint) openForm(selectedPoint);
});

const HISTORY_LABELS = { created: 'Angelegt', updated: 'Geändert', deleted: 'Gelöscht', photo_updated: 'Foto aktualisiert' };

document.getElementById('detail-history').addEventListener('click', async () => {
  if (!selectedPoint) return;
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<p class="hint">Lade Verlauf …</p>';
  document.getElementById('history-overlay').classList.add('open');
  try {
    const entries = await api(`/api/points/${selectedPoint.id}/history`);
    if (!entries.length) {
      listEl.innerHTML = '<p class="hint">Noch keine Einträge vorhanden.</p>';
      return;
    }
    listEl.innerHTML = entries
      .map((e) => {
        const when = new Date(e.changed_at).toLocaleString('de-DE');
        const who = e.username ? escapeHtml(e.username) : 'Unbekannt';
        const label = HISTORY_LABELS[e.change_type] || e.change_type;
        return `<div class="history-entry"><div class="type">${label}</div><div class="meta">${when} · ${who}</div></div>`;
      })
      .join('');
  } catch (err) {
    listEl.innerHTML = '<p class="hint">Verlauf konnte nicht geladen werden.</p>';
  }
});

document.getElementById('history-close').addEventListener('click', () => {
  document.getElementById('history-overlay').classList.remove('open');
});

document.getElementById('detail-delete').addEventListener('click', async () => {
  if (!selectedPoint) return;
  if (!confirm(`"${selectedPoint.name}" wirklich endgültig löschen? Der Verlauf bleibt archiviert.`)) return;
  await api('/api/points/' + selectedPoint.id, { method: 'DELETE' });
  document.getElementById('detail-panel').classList.remove('open');
  loadPoints();
});

// ============================================================
// Formular
// ============================================================
function openForm(point) {
  editingPointId = point ? point.id : null;
  pendingClickLatLng = point ? { lat: point.lat, lng: point.lng } : null;

  document.getElementById('form-title').textContent = point ? 'Punkt bearbeiten' : 'Neuen Punkt anlegen';
  document.getElementById('form-coords').textContent = point
    ? point.lat.toFixed(5) + ', ' + point.lng.toFixed(5)
    : '– auf die Karte klicken –';

  if (point) {
    placeTempMarker([point.lat, point.lng]);
  } else {
    clearTempMarker();
  }

  document.getElementById('f-name').value = point?.name || '';
  document.getElementById('f-category').value = point?.category_id || (categories[0] && categories[0].id) || '';
  document.getElementById('f-capacity').value = point?.capacity_liters || '';
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
}

document.getElementById('f-photo').addEventListener('change', () => {
  const file = document.getElementById('f-photo').files[0];
  const preview = document.getElementById('f-photo-preview');
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    preview.src = reader.result;
    preview.style.display = 'block';
  };
  reader.readAsDataURL(file);
});

document.getElementById('new-point-btn').addEventListener('click', () => openForm(null));
document.getElementById('form-cancel').addEventListener('click', () => {
  document.getElementById('form-overlay').classList.remove('open');
  clearTempMarker();
});

document.getElementById('point-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pendingClickLatLng) {
    alert('Bitte zuerst eine Position auf der Karte anklicken.');
    return;
  }
  const payload = {
    name: document.getElementById('f-name').value.trim(),
    category_id: Number(document.getElementById('f-category').value),
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
  const photoFile = document.getElementById('f-photo').files[0];

  async function uploadPhotoIfAny(pointId) {
    if (!photoFile) return;
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(photoFile);
    });
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
    } else {
      const created = await api('/api/points', { method: 'POST', body: JSON.stringify(payload) });
      await uploadPhotoIfAny(created.id);
    }
    document.getElementById('form-overlay').classList.remove('open');
    document.getElementById('detail-panel').classList.remove('open');
    clearTempMarker();
    loadPoints();
  } catch (err) {
    alert('Fehler beim Speichern: ' + err.message);
  }
});

// ============================================================
// Nutzerverwaltung (nur Admin)
// ============================================================
const userForm = document.getElementById('user-form');
if (userForm) {
  userForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('u-username').value.trim();
    const password = document.getElementById('u-password').value;
    const role = document.getElementById('u-role').value;
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role }) });
      alert('Nutzer "' + username + '" wurde angelegt.');
      userForm.reset();
    } catch (err) {
      alert('Fehler: ' + err.message);
    }
  });
}
