const gifOutput = document.getElementById('gif-output');
const interactiveMapEl = document.getElementById('interactive-map');
const stageOverlay = document.getElementById('stage-overlay');
const stageMessage = document.getElementById('stage-message');
const progressWrapper = document.getElementById('progress-wrapper');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

const coordDisplay = document.getElementById('coord-display');
const locationDisplay = document.getElementById('location-display');

const jumpBtn = document.getElementById('jump-btn');
const exploreBtn = document.getElementById('explore-btn');
const downloadBtn = document.getElementById('download-btn');
const shareBtn = document.getElementById('share-btn');

let isGenerating = false;
let isMapMode = false;
let currentTarget = null;
let currentGifUrl = null;
let workerBlobUrl = null;

// Leaflet Map State
let leafletMap = null;
let targetMarker = null;

// Background Preload Buffer
let preloadedJump = null;
let preloadAbortId = 0;

function generateRandomCoords() {
  const u = Math.random();
  return {
    lat: (Math.asin(2 * u - 1) * 180) / Math.PI,
    lng: Math.random() * 360 - 180
  };
}

function latLngToTileFloat(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function loadTileImage(z, x, y) {
  return new Promise((resolve) => {
    const maxTile = Math.pow(2, z);
    const wrappedX = ((x % maxTile) + maxTile) % maxTile;
    if (y < 0 || y >= maxTile) {
      resolve(null);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${wrappedX}`;
  });
}

async function renderMapFrame(lat, lng, fractionalZoom, size = 420) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#14171a';
  ctx.fillRect(0, 0, size, size);

  const baseZ = Math.max(1, Math.min(17, Math.floor(fractionalZoom)));
  const scale = Math.pow(2, fractionalZoom - baseZ);
  const tileSize = 256 * scale;

  const centerTile = latLngToTileFloat(lat, lng, baseZ);
  const halfTiles = Math.ceil(size / (2 * tileSize)) + 1;

  const startTileX = Math.floor(centerTile.x) - halfTiles;
  const endTileX = Math.floor(centerTile.x) + halfTiles;
  const startTileY = Math.floor(centerTile.y) - halfTiles;
  const endTileY = Math.floor(centerTile.y) + halfTiles;

  const tasks = [];
  for (let tx = startTileX; tx <= endTileX; tx++) {
    for (let ty = startTileY; ty <= endTileY; ty++) {
      tasks.push(
        loadTileImage(baseZ, tx, ty).then((img) => {
          if (!img) return;
          const drawX = size / 2 + (tx - centerTile.x) * tileSize;
          const drawY = size / 2 + (ty - centerTile.y) * tileSize;
          ctx.drawImage(img, drawX, drawY, tileSize + 0.6, tileSize + 0.6);
        })
      );
    }
  }
  await Promise.all(tasks);

  return canvas;
}

function buildBungeeZoomSequence(totalFrames = 28) {
  const startZoom = 2.2;
  const targetZoom = 14.5;
  const amplitude = targetZoom - startZoom;
  const gamma = 0.85;
  const omega = 4.3;
  const totalTime = 5.0;

  const zooms = [];
  for (let i = 0; i < totalFrames; i++) {
    const t = (i / (totalFrames - 1)) * totalTime;
    if (i === totalFrames - 1) {
      zooms.push(targetZoom);
    } else {
      zooms.push(targetZoom - amplitude * Math.exp(-gamma * t) * Math.cos(omega * t));
    }
  }
  return zooms;
}

async function getGifWorkerUrl() {
  if (workerBlobUrl) return workerBlobUrl;
  const res = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js');
  const code = await res.text();
  const blob = new Blob([code], { type: 'application/javascript' });
  workerBlobUrl = URL.createObjectURL(blob);
  return workerBlobUrl;
}

async function fetchLocationName(lat, lng) {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
    );
    const data = await res.json();
    const parts = [data.city || data.locality, data.principalSubdivision, data.countryName].filter(Boolean);
    if (parts.length > 0) return parts.join(', ');
    if (data.ocean) return data.ocean;
    return 'Open Ocean / Uncharted Waters';
  } catch {
    return 'Unknown Region';
  }
}

function compileGifBlob(canvases, workerUrl, onProgress) {
  return new Promise((resolve) => {
    const gif = new GIF({
      workers: 2,
      quality: 10,
      width: 420,
      height: 420,
      workerScript: workerUrl
    });

    canvases.forEach((canvas, idx) => {
      const delay = idx === canvases.length - 1 ? 1600 : 85;
      gif.addFrame(canvas, { delay });
    });

    if (onProgress) gif.on('progress', onProgress);
    gif.on('finished', (blob) => resolve(URL.createObjectURL(blob)));
    gif.render();
  });
}

function updateProgress(percent, text) {
  progressBar.style.width = `${percent}%`;
  progressText.textContent = text;
}

function showGifView() {
  isMapMode = false;
  interactiveMapEl.hidden = true;
  gifOutput.hidden = false;
  exploreBtn.textContent = 'Explore on Map';
}

function showInteractiveMapView() {
  if (!currentTarget) return;
  isMapMode = true;
  gifOutput.hidden = true;
  stageOverlay.hidden = true;
  interactiveMapEl.hidden = false;
  exploreBtn.textContent = 'Back to GIF';

  if (!leafletMap) {
    leafletMap = L.map('interactive-map', {
      center: [currentTarget.lat, currentTarget.lng],
      zoom: 12
    });

    // Base satellite imagery
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      attribution: 'Tiles &copy; Esri'
    }).addTo(leafletMap);

    // Transparent overlay with country borders, cities, and place names
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18
    }).addTo(leafletMap);

    targetMarker = L.circleMarker([currentTarget.lat, currentTarget.lng], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#8b2626',
      fillOpacity: 0.9
    }).addTo(leafletMap);
  } else {
    leafletMap.invalidateSize();
    leafletMap.setView([currentTarget.lat, currentTarget.lng], 12);
    targetMarker.setLatLng([currentTarget.lat, currentTarget.lng]);
  }
}

function applyJumpResult(lat, lng, gifUrl, locationName) {
  if (currentGifUrl && currentGifUrl !== gifUrl) {
    URL.revokeObjectURL(currentGifUrl);
  }
  currentGifUrl = gifUrl;
  currentTarget = { lat, lng };

  const newUrl = `${window.location.pathname}?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}`;
  window.history.replaceState({}, '', newUrl);

  coordDisplay.textContent = `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`;
  locationDisplay.textContent = locationName;

  gifOutput.src = gifUrl;
  stageOverlay.hidden = true;
  showGifView();

  exploreBtn.disabled = false;

  downloadBtn.href = gifUrl;
  downloadBtn.download = `bungee_${lat.toFixed(3)}_${lng.toFixed(3)}.gif`;
  downloadBtn.classList.remove('disabled');
  downloadBtn.removeAttribute('aria-disabled');

  shareBtn.disabled = false;
  jumpBtn.textContent = '▼ JUMP AGAIN';
}

async function preloadNextJump() {
  const myId = ++preloadAbortId;
  if (preloadedJump) {
    URL.revokeObjectURL(preloadedJump.gifUrl);
    preloadedJump = null;
  }

  const { lat, lng } = generateRandomCoords();

  try {
    const locationPromise = fetchLocationName(lat, lng);
    const zoomLevels = buildBungeeZoomSequence(28);
    const canvases = [];

    for (let i = 0; i < zoomLevels.length; i++) {
      if (myId !== preloadAbortId || isGenerating) return;
      const frameCanvas = await renderMapFrame(lat, lng, zoomLevels[i], 420);
      canvases.push(frameCanvas);
    }

    if (myId !== preloadAbortId || isGenerating) return;

    const workerUrl = await getGifWorkerUrl();
    const gifUrl = await compileGifBlob(canvases, workerUrl, null);
    const locationName = await locationPromise;

    if (myId !== preloadAbortId) {
      URL.revokeObjectURL(gifUrl);
      return;
    }

    preloadedJump = { lat, lng, gifUrl, locationName };
  } catch {
    // Ignore background preload errors silently
  }
}

async function executeBungeeGif(lat, lng) {
  if (isGenerating) return;
  isGenerating = true;
  preloadAbortId++;

  jumpBtn.disabled = true;
  exploreBtn.disabled = true;
  shareBtn.disabled = true;
  downloadBtn.classList.add('disabled');
  downloadBtn.setAttribute('aria-disabled', 'true');

  isMapMode = false;
  interactiveMapEl.hidden = true;
  gifOutput.hidden = true;
  stageOverlay.hidden = false;
  progressWrapper.hidden = false;
  stageMessage.textContent = 'PREPARING JUMP...';
  updateProgress(0, 'Loading satellite imagery: 0%');

  coordDisplay.textContent = `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`;
  locationDisplay.textContent = 'Locating...';

  try {
    const locationPromise = fetchLocationName(lat, lng);
    const zoomLevels = buildBungeeZoomSequence(28);
    const canvases = [];

    for (let i = 0; i < zoomLevels.length; i++) {
      const frameCanvas = await renderMapFrame(lat, lng, zoomLevels[i], 420);
      canvases.push(frameCanvas);
      const pct = Math.round(((i + 1) / zoomLevels.length) * 75);
      updateProgress(pct, `Loading satellite imagery: ${pct}%`);
    }

    stageMessage.textContent = 'CREATING ANIMATION...';
    const workerUrl = await getGifWorkerUrl();
    const gifUrl = await compileGifBlob(canvases, workerUrl, (p) => {
      const totalPct = 75 + Math.round(p * 25);
      updateProgress(totalPct, `Finalizing GIF: ${totalPct}%`);
    });

    const locationName = await locationPromise;
    applyJumpResult(lat, lng, gifUrl, locationName);
  } catch (error) {
    console.error(error);
    stageMessage.textContent = 'FAILED TO LOAD VIEW. TRY AGAIN.';
    progressWrapper.hidden = true;
  } finally {
    isGenerating = false;
    jumpBtn.disabled = false;
    preloadNextJump();
  }
}

exploreBtn.addEventListener('click', () => {
  if (!currentTarget || isGenerating) return;
  if (isMapMode) {
    showGifView();
  } else {
    showInteractiveMapView();
  }
});

jumpBtn.addEventListener('click', () => {
  if (isGenerating) return;

  if (preloadedJump) {
    const ready = preloadedJump;
    preloadedJump = null;
    applyJumpResult(ready.lat, ready.lng, ready.gifUrl, ready.locationName);
    preloadNextJump();
    return;
  }

  const coords = generateRandomCoords();
  executeBungeeGif(coords.lat, coords.lng);
});

shareBtn.addEventListener('click', async () => {
  if (!currentTarget) return;
  const shareUrl = `${window.location.origin}${window.location.pathname}?lat=${currentTarget.lat.toFixed(5)}&lng=${currentTarget.lng.toFixed(5)}`;
  try {
    await navigator.clipboard.writeText(shareUrl);
    const prev = shareBtn.textContent;
    shareBtn.textContent = 'Copied!';
    setTimeout(() => (shareBtn.textContent = prev), 1800);
  } catch {
    prompt('Copy link:', shareUrl);
  }
});

window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    executeBungeeGif(lat, lng);
  } else {
    preloadNextJump();
  }
});