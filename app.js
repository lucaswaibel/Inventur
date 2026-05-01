const STORAGE_KEY = "lagerung-verbrauchsmaterialien-v1";
const UI_STATE_KEY = "lagerung-verbrauchsmaterialien-ui-v1";
const SUPABASE_URL = "https://hivdjokpiyhojqoglund.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_yJe81u7fpngRpDSEXIQXQg_94gQ0lbw";
const CLOUD_STATE_TABLE = "app_state";
const CLOUD_STATE_ID = "main";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

let state = loadState();
let supabaseClient = null;
let cloudSaveTimer = null;
let cloudSyncEnabled = false;
let currentUser = null;
let filters = {
  query: "",
  category: "Alle",
  location: "Alle",
  status: "all",
};
let analysisFilters = defaultAnalysisFilters();
let inventoryFilters = {
  query: "",
  category: "Alle",
  location: "Alle",
};
let inventoryDraft = {};
let inventoryDirty = false;
let returnPageAfterProduct = null;
let selectedItemId = null;
let selectedAnalysisItemId = null;
let highlightedInventoryItemId = null;
let productBookingNotice = null;
let currentPage = loadSavedPage();

const categoryPalette = {
  "A. Händehygiene & Hautschutz": "#15803d",
  "B. Persönliche Schutzausrüstung (PSA)": "#2563eb",
  "C. Wundversorgung": "#ca8a04",
  "D. Diagnostik & Behandlung": "#dc2626",
  "E. Inkontinenzversorgung": "#7c3aed",
  "F. Reinigung & Entsorgung": "#0f766e",
  "G. Bürobedarf": "#475569",
  "H. Arbeitskleidung": "#be123c",
};

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return normalizeState(JSON.parse(saved));
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  return normalizeState({
    items: structuredClone(window.LAGERUNG_SEED.items),
    categories: [...new Set(window.LAGERUNG_SEED.items.map((item) => item.category).filter(Boolean))],
    locations: [...window.LAGERUNG_SEED.locations],
    movements: [],
  });
}

function defaultAnalysisFilters() {
  return {
    category: "Alle",
    location: "Alle",
    status: "all",
    period: "month",
    from: "",
    to: "",
    itemQuery: "",
    itemIds: [],
  };
}

function loadSavedPage() {
  const saved = localStorage.getItem(UI_STATE_KEY);
  return ["overview", "inventoryList", "inventory", "activity", "analytics", "options"].includes(saved) ? saved : "overview";
}

function saveUiState() {
  localStorage.setItem(UI_STATE_KEY, currentPage);
}

function normalizeState(nextState) {
  const items = (Array.isArray(nextState.items) ? nextState.items : []).map(normalizeItem);
  const itemCategories = items.map((item) => item.category).filter(Boolean);
  const itemLocations = items.flatMap((item) => itemStorageLocations(item).map((entry) => entry.ort)).filter(Boolean);
  return {
    items,
    categories: uniqueList([...(nextState.categories || []), ...itemCategories]),
    locations: uniqueList([...(nextState.locations || []).map((location) => storageFromLabel(location).ort), ...itemLocations]),
    movements: Array.isArray(nextState.movements) ? nextState.movements : [],
  };
}

function normalizeItem(item) {
  const packageParts = splitPackageSize(item.packageSize || "");
  const oldLocationLabels = item.locations || [];
  const storageLocations = (item.storageLocations?.length
    ? item.storageLocations
    : oldLocationLabels.map(storageFromLabel)
  )
    .filter((entry) => entry.ort)
    .map((entry, index) => {
      const parsedOrt = storageFromLabel(entry.ort);
      return {
        id: entry.id || `storage-${index}-${parsedOrt.ort}-${entry.regal || ""}-${entry.platz || ""}`,
        ort: parsedOrt.ort || entry.ort || "",
        regal: numberOrNull(entry.regal) ?? parsedOrt.regal,
        platz: numberOrNull(entry.platz) ?? parsedOrt.platz,
      };
    });
  const stockByLocation = {};
  storageLocations.forEach((entry, index) => {
    const nextLabel = storageLabel(entry);
    const oldLabel = oldLocationLabels[index];
    stockByLocation[nextLabel] = numberOrZero(item.stockByLocation?.[nextLabel] ?? item.stockByLocation?.[oldLabel]);
  });
  return {
    ...item,
    packageQuantity: item.packageQuantity ?? packageParts.quantity,
    packageUnit: item.packageUnit ?? packageParts.unit,
    packageSize: formatPackageSize(item.packageQuantity ?? packageParts.quantity, item.packageUnit ?? packageParts.unit),
    storageLocations,
    locations: storageLocations.map(storageLabel),
    stockByLocation,
    locationIssue: Boolean(item.locationIssue),
    removedStorageLocations: Array.isArray(item.removedStorageLocations) ? item.removedStorageLocations : [],
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleCloudSave();
}

function createSupabaseClient() {
  if (!window.supabase?.createClient) return null;
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}

async function initializeCloudState() {
  supabaseClient = createSupabaseClient();
  if (!supabaseClient) {
    console.warn("Supabase SDK nicht geladen. Die App nutzt nur den lokalen Speicher.");
    setAuthMessage("Supabase konnte nicht geladen werden.");
    renderAuthState(null);
    return;
  }
  await handleAuthRedirect();
  const { data } = await supabaseClient.auth.getSession();
  currentUser = data.session?.user || null;
  renderAuthState(currentUser);
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    cloudSyncEnabled = Boolean(currentUser);
    renderAuthState(currentUser);
    if (currentUser) {
      loadStateFromCloud();
    }
  });
  if (currentUser) {
    await loadStateFromCloud();
  }
}

async function handleAuthRedirect() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  if (accessToken && refreshToken) {
    const { error } = await supabaseClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    cleanAuthUrl();
    if (error) {
      console.warn("Supabase Redirect-Session konnte nicht übernommen werden.", error);
      setAuthMessage("Der Login-Link konnte nicht übernommen werden. Bitte fordere einen neuen Link an.");
    }
    return;
  }

  const code = new URLSearchParams(window.location.search).get("code");
  if (code) {
    const { error } = await supabaseClient.auth.exchangeCodeForSession(code);
    cleanAuthUrl();
    if (error) {
      console.warn("Supabase Auth-Code konnte nicht übernommen werden.", error);
      setAuthMessage("Der Login-Code konnte nicht übernommen werden. Bitte fordere einen neuen Link an.");
    }
  }
}

function cleanAuthUrl() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

async function loadStateFromCloud() {
  if (!supabaseClient || !currentUser) return;
  cloudSyncEnabled = true;
  const { data, error } = await supabaseClient
    .from(CLOUD_STATE_TABLE)
    .select("data")
    .eq("id", CLOUD_STATE_ID)
    .maybeSingle();
  if (error) {
    console.warn("Supabase konnte nicht geladen werden. Prüfe Tabelle und Policies.", error);
    setAuthMessage("Angemeldet, aber Cloud-Daten konnten nicht geladen werden. Prüfe die Supabase Policies.");
    return;
  }
  if (data?.data) {
    state = normalizeState(data.data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
    return;
  }
  await saveStateToCloud();
}

function renderAuthState(user) {
  const signedIn = Boolean(user);
  $("#authGate").hidden = signedIn;
  $("#appHeader").hidden = !signedIn;
  $("#appMain").hidden = !signedIn;
  $("#menuDialog").close?.();
  if (signedIn) {
    $("#authMessage").textContent = "";
  }
}

function setAuthMessage(message) {
  const target = $("#authMessage");
  if (target) target.textContent = message || "";
}

async function signIn(event) {
  event.preventDefault();
  if (!supabaseClient) return setAuthMessage("Supabase ist noch nicht geladen.");
  setAuthMessage("Anmeldung läuft...");
  const { error } = await supabaseClient.auth.signInWithPassword({
    email: $("#authEmail").value.trim(),
    password: $("#authPassword").value,
  });
  if (error) {
    setAuthMessage(error.message);
    return;
  }
  setAuthMessage("");
}

async function signUp() {
  if (!supabaseClient) return setAuthMessage("Supabase ist noch nicht geladen.");
  const form = $("#authForm");
  if (!form.reportValidity()) return;
  setAuthMessage("Konto wird erstellt...");
  const { error } = await supabaseClient.auth.signUp({
    email: $("#authEmail").value.trim(),
    password: $("#authPassword").value,
    options: {
      emailRedirectTo: authRedirectUrl(),
    },
  });
  if (error) {
    setAuthMessage(error.message);
    return;
  }
  setAuthMessage("Konto erstellt. Falls Supabase E-Mail-Bestätigung verlangt, bestätige bitte die E-Mail und melde dich danach an.");
}

function authRedirectUrl() {
  if (window.location.protocol === "file:") {
    return "https://lucaswaibel.github.io/Inventur/";
  }
  if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
    return "http://127.0.0.1:8000/index.html";
  }
  return `${window.location.origin}${window.location.pathname}`;
}

async function signOut() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  cloudSyncEnabled = false;
  currentUser = null;
  renderAuthState(null);
}

function scheduleCloudSave() {
  if (!cloudSyncEnabled || !supabaseClient || !currentUser) return;
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(() => {
    saveStateToCloud();
  }, 500);
}

async function saveStateToCloud() {
  if (!cloudSyncEnabled || !supabaseClient || !currentUser) return;
  const { error } = await supabaseClient
    .from(CLOUD_STATE_TABLE)
    .upsert({
      id: CLOUD_STATE_ID,
      data: state,
      updated_at: new Date().toISOString(),
    });
  if (error) {
    console.warn("Supabase konnte nicht gespeichert werden.", error);
  }
}

function normalizeText(value) {
  return String(value ?? "").toLowerCase().trim();
}

function numberOrZero(value) {
  const next = Number.parseInt(value, 10);
  return Number.isFinite(next) && next >= 0 ? next : 0;
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const next = Number.parseInt(value, 10);
  return Number.isFinite(next) && next >= 0 ? next : null;
}

function uniqueList(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "de"),
  );
}

function splitPackageSize(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d+)\s*(.*)$/);
  return {
    quantity: match ? Number.parseInt(match[1], 10) : null,
    unit: match ? match[2].trim() : text,
  };
}

function formatPackageSize(quantity, unit) {
  return [quantity ?? "", unit || ""].filter((part) => String(part).trim()).join(" ").trim();
}

function storageFromLabel(label) {
  const text = String(label || "").trim();
  const regalMatch = text.match(/\bRegal\s+(\d+)\b/i);
  const platzMatch = text.match(/\b(?:Platz|Boden)\s+(\d+)\b/i);
  const ort = text
    .replace(/\s*-\s*Regal\s+(?:\d+|X)\b/i, "")
    .replace(/\s*-\s*(?:Platz|Boden)\s+(?:\d+|X)\b/i, "")
    .trim();
  return {
    ort: ort || text,
    regal: regalMatch ? Number.parseInt(regalMatch[1], 10) : null,
    platz: platzMatch ? Number.parseInt(platzMatch[1], 10) : null,
  };
}

function storageLabel(entry) {
  return [
    entry.ort,
    entry.regal != null ? `Regal ${entry.regal}` : "",
    entry.platz != null ? `Platz ${entry.platz}` : "",
  ]
    .filter(Boolean)
    .join(" - ");
}

function itemStorageLocations(item) {
  const entries = item.storageLocations?.length
    ? item.storageLocations
    : (item.locations || []).map(storageFromLabel);
  return entries.filter((entry) => entry.ort);
}

function itemLocationLabels(item) {
  return itemStorageLocations(item).map(storageLabel);
}

function itemTotal(item) {
  return Object.values(item.stockByLocation || {}).reduce((sum, value) => sum + numberOrZero(value), 0);
}

function stockUnit(item) {
  return item.packageUnit || splitPackageSize(item.packageSize || "").unit || "";
}

function formatStockAmount(value, item) {
  return [value, stockUnit(item)].filter((part) => String(part).trim()).join(" ");
}

function itemStatus(item) {
  const total = itemTotal(item);
  return item.minStock != null && total < item.minStock ? "low" : "ok";
}

function reorderQuantity(item) {
  if (item.maxStock == null) return 0;
  return Math.max(0, item.maxStock - itemTotal(item));
}

function inventoryMovementsForItem(item) {
  return structuredMovements().filter((movement) =>
    (movement.itemId === item.id || movement.itemName === item.name) &&
    ["inventory", "consumption"].includes(movement.type),
  );
}

function lastInventoryMovement(item) {
  return inventoryMovementsForItem(item)
    .filter((movement) => Number.isFinite(Date.parse(movement.timestamp)))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
}

function inventoryAgeDays(item) {
  const last = lastInventoryMovement(item);
  if (!last) return null;
  return Math.floor((Date.now() - Date.parse(last.timestamp)) / 86400000);
}

function lastInventoryLabel(item) {
  const age = inventoryAgeDays(item);
  if (age == null) return "Noch keine Inventur";
  if (age === 0) return "Heute kontrolliert";
  if (age === 1) return "Gestern kontrolliert";
  return `Vor ${age} Tagen kontrolliert`;
}

function displayedStock(item) {
  if (filters.location !== "Alle") {
    return itemStorageLocations(item)
      .filter((entry) => entry.ort === filters.location)
      .reduce((sum, entry) => sum + numberOrZero(item.stockByLocation?.[storageLabel(entry)]), 0);
  }
  return itemTotal(item);
}

function visibleItems() {
  const query = normalizeText(filters.query);
  return state.items
    .filter((item) => filters.category === "Alle" || item.category === filters.category)
    .filter((item) => filters.location === "Alle" || itemStorageLocations(item).some((entry) => entry.ort === filters.location))
    .filter((item) => filters.status === "all" || itemStatus(item) === filters.status)
    .filter((item) => {
      if (!query) return true;
      const haystack = [
        item.name,
        item.brand,
        item.packageSize,
        item.category,
        item.notes,
        ...itemLocationLabels(item),
      ].join(" ");
      return normalizeText(haystack).includes(query);
    })
    .sort((a, b) => {
      const statusSort = itemStatus(a).localeCompare(itemStatus(b));
      if (statusSort !== 0) return statusSort;
      return a.name.localeCompare(b.name, "de");
    });
}

function uniqueCategories() {
  return uniqueList([...(state.categories || []), ...state.items.map((item) => item.category)]);
}

function allLocations() {
  return uniqueList([...(state.locations || []), ...state.items.flatMap((item) => itemStorageLocations(item).map((entry) => entry.ort))]);
}

function configuredLocations() {
  return uniqueList(state.locations || []);
}

function render() {
  renderPages();
  renderSummary();
  renderFilters();
  renderMaterials();
  renderCategoryOptions();
  renderActivity();
  renderOverviewDashboard();
  renderInventory();
  renderAnalysis();
  renderOptions();
  renderProductView();
}

function renderPages() {
  $("#overviewPage").hidden = currentPage !== "overview";
  $("#inventoryListPage").hidden = currentPage !== "inventoryList";
  $("#inventoryPage").hidden = currentPage !== "inventory";
  $("#activityPage").hidden = currentPage !== "activity";
  $("#analyticsPage").hidden = currentPage !== "analytics";
  $("#optionsPage").hidden = currentPage !== "options";
  $("#appTitle").textContent = pageTitle(currentPage);
  saveUiState();
}

function pageTitle(page) {
  if (page === "inventoryList") return selectedItemId ? "Artikel" : "Inventar";
  if (page === "inventory") return "Inventur";
  if (page === "activity") return "Letzte Buchungen";
  if (page === "analytics") return "Auswertungen";
  if (page === "options") return "Optionen";
  return "Übersicht";
}

function renderSummary() {
  $("#lowCount").textContent = state.items.filter((item) => itemStatus(item) === "low").length;
  $("#itemCount").textContent = state.items.length;
  $("#locationCount").textContent = configuredLocations().length;
}

function renderFilters() {
  const categoryValue = filters.category;
  const locationValue = filters.location;
  $("#statusFilter").value = filters.status;
  $("#categoryFilter").innerHTML = ["Alle", ...uniqueCategories()]
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(shortCategory(category))}</option>`)
    .join("");
  $("#categoryFilter").value = categoryValue;
  $("#locationFilter").innerHTML = ["Alle", ...allLocations()]
    .map((location) => `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`)
    .join("");
  $("#locationFilter").value = locationValue;
  renderAnalysisFilters();
  renderInventoryFilters();
}

function renderAnalysisFilters() {
  const categoryValue = analysisFilters.category;
  const locationValue = analysisFilters.location;
  ensureAnalysisDateRange();
  $("#analysisStatusFilter").value = analysisFilters.status;
  $("#analysisCategoryFilter").innerHTML = ["Alle", ...uniqueCategories()]
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(shortCategory(category))}</option>`)
    .join("");
  $("#analysisCategoryFilter").value = categoryValue;
  $("#analysisLocationFilter").innerHTML = ["Alle", ...allLocations()]
    .map((location) => `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`)
    .join("");
  $("#analysisLocationFilter").value = locationValue;
  $("#analysisPeriodFilter").value = analysisFilters.period;
  $("#analysisFromDate").value = analysisFilters.from;
  $("#analysisToDate").value = analysisFilters.to;
  $("#analysisItemSearch").value = analysisFilters.itemQuery;
  renderAnalysisItemPicker();
}

function renderAnalysisItemPicker() {
  const query = normalizeText(analysisFilters.itemQuery);
  const selectedIds = new Set(analysisFilters.itemIds);
  const matches = state.items
    .filter((item) => {
      if (!query) return true;
      return normalizeText([item.name, item.brand, item.packageSize, item.category].join(" ")).includes(query);
    })
    .sort((a, b) => analysisItemLabel(a).localeCompare(analysisItemLabel(b), "de"))
    .slice(0, 30);
  $("#analysisItemDropdown").innerHTML = matches.length
    ? matches.map((item) => `
        <label class="checkbox-row">
          <input type="checkbox" data-analysis-item-option="${escapeHtml(item.id)}" ${selectedIds.has(item.id) ? "checked" : ""} />
          <span>${escapeHtml(analysisItemLabel(item))}</span>
        </label>
      `).join("")
    : `<p class="empty-inline">Keine Artikel gefunden.</p>`;
  const selectedItems = state.items.filter((item) => selectedIds.has(item.id));
  $("#analysisSelectedItems").innerHTML = selectedItems.length
    ? selectedItems.map((item) => `
        <button type="button" class="selected-chip" data-remove-analysis-item="${escapeHtml(item.id)}">
          ${escapeHtml(analysisItemLabel(item))} ×
        </button>
      `).join("")
    : `<span>Alle Artikel</span>`;
}

function renderInventoryFilters() {
  const categoryValue = inventoryFilters.category;
  const locationValue = inventoryFilters.location;
  $("#inventoryCategoryFilter").innerHTML = ["Alle", ...uniqueCategories()]
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(shortCategory(category))}</option>`)
    .join("");
  $("#inventoryCategoryFilter").value = categoryValue;
  $("#inventoryLocationFilter").innerHTML = ["Alle", ...allLocations()]
    .map((location) => `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`)
    .join("");
  $("#inventoryLocationFilter").value = locationValue;
}

function renderMaterials() {
  const items = visibleItems();
  const titleParts = [];
  if (filters.status === "low") titleParts.push("Knappe Artikel");
  if (filters.status === "ok") titleParts.push("Artikel mit OK-Bestand");
  if (filters.category !== "Alle") titleParts.push(shortCategory(filters.category));
  if (filters.location !== "Alle") titleParts.push(filters.location);
  $("#listTitle").textContent = titleParts.length ? titleParts.join(" · ") : "Alle Artikel";
  $("#materialsList").innerHTML = items.length
    ? items.map(renderMaterialCard).join("")
    : `<div class="empty">Keine Materialien gefunden.</div>`;
}

function renderMaterialCard(item) {
  const total = displayedStock(item);
  const status = itemStatus(item);
  const color = categoryPalette[item.category] || "#0f766e";
  const packageSize = formatPackageSize(item.packageQuantity, item.packageUnit) || item.packageSize;
  return `
    <button class="material-card compact-card ${item.locationIssue ? "has-location-issue" : ""}" type="button" data-id="${escapeHtml(item.id)}" style="border-left-color: ${color}">
        <div>
          <h3 class="card-title">${escapeHtml(item.name)}</h3>
          <div class="meta">
            ${packageSize ? `<span>${escapeHtml(packageSize)}</span>` : ""}
            ${filters.location !== "Alle" ? `<span>${escapeHtml(filters.location)}</span>` : ""}
            ${item.locationIssue ? `<span class="issue-text">Lagerort prüfen</span>` : ""}
          </div>
        </div>
        <div class="compact-stock">
          <span class="stock-number">${total}</span>
          <span class="stock-min">Min ${item.minStock ?? "–"}</span>
        </div>
        <span class="badge ${item.locationIssue ? "issue" : status}">${item.locationIssue ? "Prüfen" : status === "low" ? "Knapp" : "OK"}</span>
    </button>
  `;
}

function renderStockRow(item, location) {
  const hasLocation = location !== "Ohne Lagerort";
  const value = hasLocation ? numberOrZero(item.stockByLocation?.[location]) : 0;
  return `
    <div class="stock-row" data-location="${escapeHtml(location)}">
      <div class="stock-location">
        <strong>${escapeHtml(location)}</strong>
        <span class="stock-label">Bestand</span>
      </div>
      <div class="stepper">
        <button data-action="decrement" ${hasLocation ? "" : "disabled"} aria-label="Bestand reduzieren">−</button>
        <input data-action="set-stock" type="number" min="0" inputmode="numeric" value="${value}" ${hasLocation ? "" : "disabled"} aria-label="Bestand ${escapeHtml(location)}" />
        <button data-action="increment" ${hasLocation ? "" : "disabled"} aria-label="Bestand erhöhen">+</button>
      </div>
    </div>
  `;
}

function renderProductView() {
  const view = $("#productView");
  if (!selectedItemId) {
    view.hidden = true;
    $("#listView").hidden = false;
    return;
  }
  const item = state.items.find((entry) => entry.id === selectedItemId);
  if (!item) {
    selectedItemId = null;
    view.hidden = true;
    $("#listView").hidden = false;
    return;
  }
  const total = itemTotal(item);
  const status = itemStatus(item);
  const locationOptions = itemLocationLabels(item);
  const packageSize = formatPackageSize(item.packageQuantity, item.packageUnit) || item.packageSize;
  const bookingMessage = productBookingNotice?.itemId === item.id ? productBookingNotice.text : "";
  view.hidden = false;
  $("#listView").hidden = true;
  view.innerHTML = `
    <div class="product-head">
      <button type="button" data-action="back-to-list">← ${returnPageAfterProduct === "inventory" ? "Inventur" : returnPageAfterProduct === "overview" ? "Übersicht" : "Inventar"}</button>
      <button type="button" data-action="edit">Bearbeiten</button>
    </div>
    <article class="product-panel">
      <div class="product-title-row">
        <div>
          <p class="eyebrow">${escapeHtml(shortCategory(item.category || ""))}</p>
          <h2>${escapeHtml(item.name)}</h2>
          <p class="product-subtitle">${escapeHtml([packageSize, item.brand].filter(Boolean).join(" · "))}</p>
        </div>
        <div class="total product-total">
          <strong>${escapeHtml(formatStockAmount(total, item))}</strong>
          <span class="badge ${status}">${status === "low" ? "Knapp" : "OK"}</span>
          <span class="stock-label">Min ${item.minStock ?? "–"}${item.maxStock != null ? ` · Max ${item.maxStock}` : ""}</span>
        </div>
      </div>
      <div class="product-actions">
        <div class="product-booking-panel">
          <label>
            <span>Aktion</span>
            <select id="productBookingType">
              <option value="inventory">Inventur erfassen</option>
              <option value="input">Wareneingang erfassen</option>
            </select>
          </label>
          <label>
            <span>Lagerplatz</span>
            <select id="productBookingLocation" ${locationOptions.length ? "" : "disabled"}>
              ${locationOptions.length
                ? locationOptions.map((location) => `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`).join("")
                : `<option value="">Kein Lagerplatz</option>`}
            </select>
          </label>
          <label>
            <span>Anzahl</span>
            <input id="productBookingQuantity" type="number" min="0" step="1" inputmode="numeric" />
          </label>
          <button type="button" class="primary" data-action="save-product-booking">Buchung speichern</button>
        </div>
        ${bookingMessage ? `<p class="booking-message" role="status">${escapeHtml(bookingMessage)}</p>` : ""}
        <button type="button" class="button-link" data-action="open-product-analysis">Zur Auswertung</button>
        ${renderProductHistory(item)}
        <p class="note"><strong>Inventur:</strong> Trage den gezählten Bestand ein. Sinkende Differenzen werden als berechneter Verbrauch gespeichert, steigende Differenzen als Inventurkorrektur. Wareneingänge werden über die Aktion „Wareneingang erfassen“ gebucht.</p>
        ${reorderQuantity(item) > 0 ? `<p class="reorder-note">Bestellvorschlag: ${escapeHtml(formatStockAmount(reorderQuantity(item), item))} bis Maximalbestand ${escapeHtml(formatStockAmount(item.maxStock, item))}</p>` : ""}
        <p class="note">Letzte Inventur: ${escapeHtml(lastInventoryLabel(item))}</p>
        ${item.link ? `<a class="button-link" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">Shop</a>` : ""}
        ${item.notes ? `<p class="note">${escapeHtml(item.notes)}</p>` : ""}
      </div>
    </article>
  `;
}

function renderProductHistory(item) {
  const rows = structuredMovements()
    .filter((movement) => movement.itemId === item.id || movement.itemName === item.name)
    .filter((movement) => ["input", "inventory", "consumption"].includes(movement.type))
    .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
  const body = rows.length
    ? rows.map((movement) => {
        const delta = `${movement.delta > 0 ? "+" : ""}${movement.delta}`;
        return `
          <tr>
            <td>${escapeHtml(formatDateTime(movement.timestamp))}</td>
            <td>${escapeHtml(movementTypeLabel(movement.type))}</td>
            <td>${escapeHtml(delta)}</td>
            <td>${movement.before ?? "–"}</td>
            <td>${movement.after ?? "–"}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="5">Noch keine Inventuren oder Wareneingänge.</td></tr>`;
  return `
    <section class="product-history">
      <h3>Inventuren und Bestellungen</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th>Typ</th>
              <th>Anzahl</th>
              <th>Vorher</th>
              <th>Nachher</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderCategoryOptions() {
  $("#categoryOptions").innerHTML = uniqueCategories()
    .map((category) => `<option value="${escapeHtml(category)}"></option>`)
    .join("");
}

function renderActivity() {
  const list = $("#movementPageList");
  if (!list) return;
  list.innerHTML = state.movements.length
    ? state.movements
        .map((movement) => `<li>${escapeHtml(movementLabel(movement))}</li>`)
        .join("")
    : `<li class="empty-line">Noch keine Buchungen.</li>`;
}

function overviewRows() {
  const lowItems = state.items.filter((item) => itemStatus(item) === "low");
  const dueItems = state.items.filter((item) => inventoryAgeDays(item) == null || inventoryAgeDays(item) > 30);
  const reorderRows = state.items
    .map((item) => ({ item, quantity: reorderQuantity(item) }))
    .filter((row) => row.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity || a.item.name.localeCompare(b.item.name, "de"));
  return { lowItems, dueItems, reorderRows };
}

function renderOverviewDashboard() {
  const sections = $("#overviewSections");
  if (!sections) return;
  const { reorderRows } = overviewRows();
  sections.innerHTML = renderReorderSuggestions(reorderRows);
}

function renderReorderSuggestions(rows) {
  const body = rows.length
    ? rows.map(({ item, quantity }) => `
        <button type="button" class="reorder-card" data-open-item-id="${escapeHtml(item.id)}">
          <span class="reorder-title">${escapeHtml([item.name, item.brand].filter(Boolean).join(" · "))}</span>
          <span class="reorder-detail">Bestand ${escapeHtml(formatStockAmount(itemTotal(item), item))} · Vorschlag ${escapeHtml(formatStockAmount(quantity, item))} bis Max ${escapeHtml(formatStockAmount(item.maxStock, item))}</span>
        </button>
      `).join("")
    : `<div class="empty">Aktuell keine Bestellvorschläge.</div>`;
  return `
    <section class="reorder-panel">
      <h3>Bestellvorschläge</h3>
      <div class="reorder-list">${body}</div>
    </section>
  `;
}

function renderInventory() {
  const status = $("#inventoryStatus");
  const list = $("#inventoryCountList");
  if (!status || !list) return;
  if (document.activeElement !== $("#inventorySearchInput")) {
    $("#inventorySearchInput").value = inventoryFilters.query;
  }
  const items = visibleInventoryItems();
  const counted = Object.keys(inventoryDraft).length;
  const changed = inventoryDraftChanges().length;
  status.innerHTML = `
    <span>${items.length} Artikel sichtbar</span>
    <span>${counted} gezählt</span>
    <span>${changed} Änderungen</span>
  `;
  $("#confirmInventory").disabled = !inventoryDirty;
  list.innerHTML = items.length
    ? items.map(renderInventoryCountRow).join("")
    : `<div class="empty">Keine Artikel für diese Inventurfilter gefunden.</div>`;
}

function visibleInventoryItems() {
  const query = normalizeText(inventoryFilters.query);
  return state.items
    .filter((item) => inventoryFilters.category === "Alle" || item.category === inventoryFilters.category)
    .filter((item) => inventoryFilters.location === "Alle" || itemStorageLocations(item).some((entry) => entry.ort === inventoryFilters.location))
    .filter((item) => {
      if (!query) return true;
      return normalizeText([item.name, item.brand, item.category, item.packageSize, ...itemLocationLabels(item)].join(" ")).includes(query);
    })
    .sort((a, b) => {
      if (a.id === highlightedInventoryItemId) return -1;
      if (b.id === highlightedInventoryItemId) return 1;
      return a.name.localeCompare(b.name, "de");
    });
}

function renderInventoryCountRow(item) {
  const systemStock = inventorySystemStock(item);
  const draftValue = inventoryDraft[item.id] ?? "";
  const counted = draftValue !== "";
  const difference = counted ? numberOrZero(draftValue) - systemStock : null;
  return `
    <article class="inventory-count-row ${counted ? "is-counted" : ""} ${item.id === highlightedInventoryItemId ? "is-highlighted" : ""}">
      <button type="button" class="inventory-item-name" data-open-item-id="${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml([item.brand, shortCategory(item.category || "")].filter(Boolean).join(" · "))}</span>
      </button>
      <div class="inventory-system-stock">
        <span>System</span>
        <strong>${escapeHtml(formatStockAmount(systemStock, item))}</strong>
      </div>
      <label class="inventory-count-input">
        <span>Gezählt${stockUnit(item) ? ` (${escapeHtml(stockUnit(item))})` : ""}</span>
        <input data-inventory-count="${escapeHtml(item.id)}" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(draftValue)}" />
      </label>
      <div class="inventory-difference ${difference == null ? "" : difference < 0 ? "is-negative" : difference > 0 ? "is-positive" : "is-zero"}">
        <span>Differenz</span>
        <strong>${difference == null ? "–" : escapeHtml(formatStockAmount(difference > 0 ? `+${difference}` : difference, item))}</strong>
      </div>
    </article>
  `;
}

function renderInventoryTable(title, rows) {
  const body = rows.length
    ? rows.map(({ item, detail, value }) => `
        <tr class="clickable-row" data-open-item-id="${escapeHtml(item.id)}" tabindex="0">
          <td>${escapeHtml([item.name, item.brand].filter(Boolean).join(" · "))}</td>
          <td>${escapeHtml(detail)}</td>
          <td>${value}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="3">Alles im grünen Bereich.</td></tr>`;
  return `
    <section class="analysis-table-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Artikel</th>
              <th>Hinweis</th>
              <th>Bestand</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function inventorySystemStock(item) {
  return itemTotal(item);
}

function inventoryDraftChanges() {
  return inventoryDraftEntries().filter((entry) => entry.previous !== entry.next);
}

function inventoryDraftEntries() {
  return Object.entries(inventoryDraft)
    .map(([itemId, value]) => {
      const item = state.items.find((entry) => entry.id === itemId);
      if (!item || value === "") return null;
      const previous = inventorySystemStockForItem(item);
      const next = numberOrZero(value);
      return { item, previous, next, delta: next - previous };
    })
    .filter(Boolean);
}

function inventorySystemStockForItem(item) {
  return itemTotal(item);
}

function confirmInventoryDraft() {
  const entries = inventoryDraftEntries();
  entries.forEach(({ item, previous, next, delta }) => {
    applyInventoryCount(item, next, previous, delta);
  });
  discardInventoryDraft();
  saveState();
  render();
}

function updateInventoryDraft(itemId, value) {
  if (value === "") {
    delete inventoryDraft[itemId];
  } else {
    inventoryDraft[itemId] = String(numberOrZero(value));
  }
  inventoryDirty = Object.keys(inventoryDraft).length > 0;
  updateInventoryStatusOnly();
}

function saveProductBooking() {
  const item = state.items.find((entry) => entry.id === selectedItemId);
  if (!item) return;
  const type = $("#productBookingType").value;
  const quantity = numberOrZero($("#productBookingQuantity").value);
  const targetLocation = $("#productBookingLocation")?.value || inventoryTargetLocation(item);
  if (!targetLocation) {
    window.alert("Bitte zuerst einen Lagerplatz beim Artikel anlegen.");
    return;
  }
  if (!quantity && type === "input") {
    window.alert("Bitte eine Anzahl größer als 0 eingeben.");
    return;
  }
  if (type === "inventory") {
    const previous = itemTotal(item);
    const delta = quantity - previous;
    applyInventoryCount(item, quantity, previous, delta, targetLocation);
  } else {
    applyProductInput(item, quantity, targetLocation);
  }
  productBookingNotice = {
    itemId: item.id,
    text: `${movementTypeLabel(type === "input" ? "input" : "inventory")} gespeichert: ${formatStockAmount(quantity, item)}`,
  };
  $("#productBookingQuantity").value = "";
  saveState();
  render();
}

function applyProductInput(item, quantity, targetLocation = null) {
  const location = targetLocation || inventoryTargetLocation(item);
  if (!location) return;
  item.stockByLocation ||= {};
  const previousLocationStock = numberOrZero(item.stockByLocation[location]);
  const previousTotal = itemTotal(item);
  item.stockByLocation[location] = previousLocationStock + quantity;
  addMovement({
    delta: quantity,
    type: "input",
    itemId: item.id,
    itemName: item.name,
    category: item.category,
    location,
    ort: storageFromLabel(location).ort,
    before: previousTotal,
    after: previousTotal + quantity,
  });
}

function openProductAnalysis(itemId) {
  analysisFilters = defaultAnalysisFilters();
  analysisFilters.itemIds = [itemId];
  selectedAnalysisItemId = itemId;
  selectedItemId = null;
  returnPageAfterProduct = null;
  currentPage = "analytics";
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateInventoryStatusOnly() {
  const status = $("#inventoryStatus");
  const confirmButton = $("#confirmInventory");
  if (!status || !confirmButton) return;
  const visibleCount = visibleInventoryItems().length;
  const counted = Object.keys(inventoryDraft).length;
  const changed = inventoryDraftChanges().length;
  status.innerHTML = `
    <span>${visibleCount} Artikel sichtbar</span>
    <span>${counted} gezählt</span>
    <span>${changed} Änderungen</span>
  `;
  confirmButton.disabled = !inventoryDirty;
}

function applyInventoryCount(item, nextTotal, previousTotal, delta, preferredLocation = null) {
  const targetLocation = preferredLocation || inventoryTargetLocation(item);
  if (!targetLocation) return;
  item.stockByLocation ||= {};
  const previousLocationStock = numberOrZero(item.stockByLocation[targetLocation]);
  const nextLocationStock = Math.max(0, previousLocationStock + delta);
  item.stockByLocation[targetLocation] = nextLocationStock;
  addMovement({
    delta,
    type: delta < 0 ? "consumption" : "inventory",
    itemId: item.id,
    itemName: item.name,
    category: item.category,
    location: targetLocation,
    ort: storageFromLabel(targetLocation).ort,
    before: previousTotal,
    after: nextTotal,
  });
}

function inventoryTargetLocation(item) {
  const labels = itemLocationLabels(item);
  if (!labels.length) return null;
  if (inventoryFilters.location === "Alle") return labels[0];
  return labels.find((location) => storageFromLabel(location).ort === inventoryFilters.location) || labels[0];
}

function renderAnalysis() {
  const movements = filteredStructuredMovements();
  const periodDays = analysisSelectedPeriodDays();
  const itemRows = aggregateItemMovements(movements);
  $("#analysisTables").innerHTML = [
    renderAnalysisItemDetail(),
    renderAnalysisTable("Nach Artikel", itemRows, periodDays, { itemLinks: true }),
  ].join("");
}

function renderOptions() {
  if (document.activeElement === $("#categoryListInput") || document.activeElement === $("#locationListInput")) return;
  $("#categoryListInput").value = uniqueCategories().join("\n");
  $("#locationListInput").value = configuredLocations().join("\n");
}

function renderStorageLocationRows(entries = []) {
  const rows = entries.length ? entries : [{ ort: configuredLocations()[0] || "", regal: null, platz: null, stock: 0 }];
  $("#storageLocationRows").innerHTML = rows.map(renderStorageLocationRow).join("");
}

function renderStorageLocationRow(entry = {}) {
  return `
    <div class="storage-location-row">
      <label>
        <span>Ort</span>
        <select data-storage-field="ort">
          ${configuredLocations()
            .map((location) => `<option value="${escapeHtml(location)}" ${location === entry.ort ? "selected" : ""}>${escapeHtml(location)}</option>`)
            .join("")}
        </select>
      </label>
      <label>
        <span>Regal</span>
        <input data-storage-field="regal" type="number" min="0" step="1" inputmode="numeric" value="${entry.regal ?? ""}" />
      </label>
      <label>
        <span>Platz</span>
        <input data-storage-field="platz" type="number" min="0" step="1" inputmode="numeric" value="${entry.platz ?? ""}" />
      </label>
      <label>
        <span>Bestand</span>
        <input data-storage-field="stock" type="number" min="0" step="1" inputmode="numeric" value="${entry.stock ?? 0}" />
      </label>
      <button type="button" class="icon-button danger" data-action="remove-storage-location" aria-label="Lagerplatz entfernen">×</button>
    </div>
  `;
}

function readStorageLocationRows() {
  return $$(".storage-location-row")
    .map((row, index) => ({
      id: `storage-${index}-${Date.now()}`,
      ort: $('[data-storage-field="ort"]', row)?.value.trim() || "",
      regal: numberOrNull($('[data-storage-field="regal"]', row)?.value),
      platz: numberOrNull($('[data-storage-field="platz"]', row)?.value),
      stock: numberOrZero($('[data-storage-field="stock"]', row)?.value),
    }))
    .filter((entry) => entry.ort);
}

function structuredMovements() {
  return (state.movements || [])
    .map((movement) => {
      if (typeof movement.delta === "number" && movement.itemName && movement.location) {
        return {
          ...movement,
          type: movement.type || movementTypeFromDelta(movement.delta),
        };
      }
      return movementFromLegacyLabel(movement);
    })
    .filter(Boolean);
}

function filteredStructuredMovements() {
  const dateRange = analysisDateRange();
  return structuredMovements().filter((movement) => {
    const item = state.items.find((entry) => entry.id === movement.itemId || entry.name === movement.itemName);
    const status = item ? itemStatus(item) : "ok";
    const category = movement.category || item?.category || "";
    return (
      (analysisFilters.status === "all" || status === analysisFilters.status) &&
      (analysisFilters.category === "Alle" || category === analysisFilters.category) &&
      (analysisFilters.location === "Alle" || movement.ort === analysisFilters.location || movement.location === analysisFilters.location) &&
      (!analysisFilters.itemIds.length || analysisFilters.itemIds.includes(item?.id || movement.itemId)) &&
      movementInDateRange(movement, dateRange)
    );
  });
}

function movementFromLegacyLabel(movement) {
  const label = movementLabel(movement);
  const match = label.match(/:\s*([+-]\d+)\s+(.+)\s+·\s+(.+)$/);
  if (!match) return null;
  const itemName = match[2].trim();
  const item = state.items.find((entry) => entry.name === itemName);
  return {
    id: movement.id || crypto.randomUUID(),
    timestamp: movement.timestamp || "",
    delta: Number.parseInt(match[1], 10),
    type: movementTypeFromDelta(Number.parseInt(match[1], 10)),
    itemId: item?.id || "",
    itemName,
    category: item?.category || "",
    location: match[3].trim(),
    ort: storageFromLabel(match[3].trim()).ort,
    label,
  };
}

function movementTypeFromDelta(delta) {
  if (delta > 0) return "input";
  if (delta < 0) return "consumption";
  return "inventory";
}

function movementTypeLabel(type) {
  if (type === "input") return "Wareneingang";
  if (type === "consumption") return "Berechneter Verbrauch";
  if (type === "inventory") return "Inventur / Korrektur";
  return "Buchung";
}

function isConsumptionMovement(movement) {
  return movement.type === "consumption" || (!movement.type && movement.delta < 0);
}

function isInputMovement(movement) {
  return movement.type === "input" || (!movement.type && movement.delta > 0);
}

function ensureAnalysisDateRange() {
  if (analysisFilters.period === "custom" && analysisFilters.from && analysisFilters.to) return;
  const range = presetDateRange(analysisFilters.period);
  analysisFilters.from = range.from;
  analysisFilters.to = range.to;
}

function presetDateRange(period) {
  const to = new Date();
  const from = new Date(to);
  if (period === "week") from.setDate(from.getDate() - 7);
  else if (period === "year") from.setFullYear(from.getFullYear() - 1);
  else from.setMonth(from.getMonth() - 1);
  return {
    from: dateInputValue(from),
    to: dateInputValue(to),
  };
}

function analysisDateRange() {
  ensureAnalysisDateRange();
  const from = startOfDay(analysisFilters.from);
  const to = endOfDay(analysisFilters.to);
  return from <= to ? { from, to } : { from: startOfDay(analysisFilters.to), to: endOfDay(analysisFilters.from) };
}

function movementInDateRange(movement, range) {
  const time = Date.parse(movement.timestamp);
  if (!Number.isFinite(time)) return false;
  return time >= range.from.getTime() && time <= range.to.getTime();
}

function analysisSelectedPeriodDays() {
  const range = analysisDateRange();
  const span = range.to.getTime() - range.from.getTime();
  return Math.max(1, Math.ceil(span / 86400000));
}

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(value) {
  const date = value ? new Date(`${value}T00:00:00`) : new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value) {
  const date = value ? new Date(`${value}T23:59:59`) : new Date();
  date.setHours(23, 59, 59, 999);
  return date;
}

function aggregateMovements(movements, keyFn) {
  const groups = new Map();
  movements.forEach((movement) => {
    const key = keyFn(movement);
    const row = groups.get(key) || { name: key, input: 0, output: 0 };
    if (isInputMovement(movement)) row.input += movement.delta;
    if (isConsumptionMovement(movement)) row.output += Math.abs(movement.delta);
    groups.set(key, row);
  });
  return [...groups.values()].sort((a, b) => b.output - a.output || a.name.localeCompare(b.name, "de"));
}

function aggregateItemMovements(movements) {
  const groups = new Map();
  state.items.filter(itemMatchesAnalysisFilters).forEach((item) => {
    groups.set(item.id, {
      id: item.id,
      name: analysisItemLabel(item),
      input: 0,
      output: 0,
    });
  });
  movements.forEach((movement) => {
    const item = state.items.find((entry) => entry.id === movement.itemId || entry.name === movement.itemName);
    const id = item?.id || movement.itemId || movement.itemName || "unknown";
    const row = groups.get(id) || {
      id,
      name: item ? analysisItemLabel(item) : movement.itemName || "Unbekannter Artikel",
      input: 0,
      output: 0,
    };
    if (isInputMovement(movement)) row.input += movement.delta;
    if (isConsumptionMovement(movement)) row.output += Math.abs(movement.delta);
    groups.set(id, row);
  });
  return [...groups.values()].sort((a, b) => b.output - a.output || a.name.localeCompare(b.name, "de"));
}

function itemMatchesAnalysisFilters(item) {
  return (
    (analysisFilters.status === "all" || itemStatus(item) === analysisFilters.status) &&
    (analysisFilters.category === "Alle" || item.category === analysisFilters.category) &&
    (analysisFilters.location === "Alle" || itemStorageLocations(item).some((entry) => entry.ort === analysisFilters.location)) &&
    (!analysisFilters.itemIds.length || analysisFilters.itemIds.includes(item.id))
  );
}

function analysisItemLabel(item) {
  return [item.name, item.brand].filter(Boolean).join(" · ");
}

function renderAnalysisTable(title, rows, periodDays, options = {}) {
  const body = rows.length
    ? rows
        .map(
          (row) => `
            <tr ${options.itemLinks ? `class="clickable-row" data-analysis-item-id="${escapeHtml(row.id)}" tabindex="0"` : ""}>
              <td>${escapeHtml(row.name)}</td>
              <td>${row.input}</td>
              <td>${row.output}</td>
              <td>${formatNumber((row.output / periodDays) * 7)}</td>
            </tr>
          `,
        )
        .join("")
    : `<tr><td colspan="4">Keine auswertbaren Buchungen.</td></tr>`;
  return `
    <section class="analysis-table-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Eingang</th>
              <th>Verbrauch</th>
              <th>Ø / 7 Tage</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderAnalysisItemDetail() {
  if (!selectedAnalysisItemId) return "";
  const item = state.items.find((entry) => entry.id === selectedAnalysisItemId);
  if (!item) {
    selectedAnalysisItemId = null;
    return "";
  }
  const movements = filteredStructuredMovements()
    .filter((movement) => movement.itemId === item.id || movement.itemName === item.name)
    .sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
  const series = stockHistoryForItem(item, movements);
  const input = movements.filter(isInputMovement).reduce((sum, movement) => sum + movement.delta, 0);
  const output = movements.filter(isConsumptionMovement).reduce((sum, movement) => sum + Math.abs(movement.delta), 0);
  const periodDays = analysisSelectedPeriodDays();
  const tableRows = movements.length
    ? movements
        .slice()
        .reverse()
        .map((movement) => {
          const delta = `${movement.delta > 0 ? "+" : ""}${movement.delta}`;
          return `
            <tr>
              <td>${escapeHtml(formatDateTime(movement.timestamp))}</td>
              <td>${escapeHtml(movement.location || "Ohne Lagerort")}</td>
              <td>${escapeHtml(delta)}</td>
              <td>${movement.before ?? "–"}</td>
              <td>${movement.after ?? "–"}</td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="5">Für diesen Artikel gibt es im aktuellen Filter noch keine Buchungen.</td></tr>`;
  return `
    <section class="analysis-detail-card">
      <div class="analysis-detail-head">
        <div>
          <p class="eyebrow">Bestandsentwicklung</p>
          <h3>${escapeHtml(item.name)}</h3>
          ${analysisItemLabel(item) !== item.name ? `<p class="analysis-detail-subtitle">${escapeHtml(analysisItemLabel(item).replace(`${item.name} · `, ""))}</p>` : ""}
        </div>
        <button type="button" data-action="close-analysis-detail">Schließen</button>
      </div>
      <div class="analysis-detail-metrics">
        <article class="mini-metric"><span>Aktueller Bestand</span><strong>${analysisCurrentStock(item)}</strong></article>
        <article class="mini-metric"><span>Eingang</span><strong>${input}</strong></article>
        <article class="mini-metric"><span>Berechneter Verbrauch</span><strong>${output}</strong></article>
        <article class="mini-metric"><span>Ø Verbrauch / 7 Tage</span><strong>${formatNumber((output / periodDays) * 7)}</strong></article>
      </div>
      ${renderStockChart(series)}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th>Lagerplatz</th>
              <th>Buchung</th>
              <th>Vorher</th>
              <th>Nachher</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function analysisCurrentStock(item) {
  if (analysisFilters.location === "Alle") return itemTotal(item);
  return itemLocationLabels(item)
    .filter((location) => storageFromLabel(location).ort === analysisFilters.location || location === analysisFilters.location)
    .reduce((sum, location) => sum + numberOrZero(item.stockByLocation?.[location]), 0);
}

function stockHistoryForItem(item, movements) {
  const sortedDesc = movements.slice().sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
  let running = analysisCurrentStock(item);
  const points = [];
  sortedDesc.forEach((movement) => {
    points.push({
      timestamp: movement.timestamp,
      label: formatDateTime(movement.timestamp),
      value: running,
    });
    running -= movement.delta;
  });
  if (sortedDesc.length) {
    const oldest = sortedDesc.at(-1);
    points.push({
      timestamp: oldest.timestamp,
      label: `${formatDateTime(oldest.timestamp)} vorher`,
      value: running,
    });
  } else {
    points.push({
      timestamp: new Date().toISOString(),
      label: "Aktuell",
      value: running,
    });
  }
  return points.reverse();
}

function renderStockChart(points) {
  const width = 640;
  const height = 220;
  const padding = 28;
  const values = points.map((point) => point.value);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const range = Math.max(1, max - min);
  const xStep = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = padding + index * xStep;
    const y = height - padding - ((point.value - min) / range) * (height - padding * 2);
    return { ...point, x, y };
  });
  const path = coords.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${path} L ${coords.at(-1).x.toFixed(1)} ${height - padding} L ${coords[0].x.toFixed(1)} ${height - padding} Z`;
  return `
    <div class="stock-chart" role="img" aria-label="Grafische Bestandsentwicklung">
      <svg viewBox="0 0 ${width} ${height}" focusable="false">
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" class="chart-axis"></line>
        <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" class="chart-axis"></line>
        <path d="${area}" class="chart-area"></path>
        <path d="${path}" class="chart-line"></path>
        ${coords
          .map(
            (point) => `
              <g>
                <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" class="chart-point"></circle>
                <text x="${point.x.toFixed(1)}" y="${Math.max(14, point.y - 10).toFixed(1)}">${point.value}</text>
              </g>
            `,
          )
          .join("")}
      </svg>
      <div class="chart-labels">
        <span>${escapeHtml(coords[0]?.label || "")}</span>
        <span>${escapeHtml(coords.at(-1)?.label || "")}</span>
      </div>
    </div>
  `;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Ohne Datum";
  return date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

function formatNumber(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(Number.isFinite(value) ? value : 0);
}

function shortCategory(category) {
  return category.replace(/^[A-Z]\.\s*/, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateStock(itemId, location, nextValue, deltaLabel = null, type = "inventory") {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item || !location || location === "Ohne Lagerort") return;
  item.stockByLocation ||= {};
  const previous = numberOrZero(item.stockByLocation[location]);
  const next = numberOrZero(nextValue);
  item.stockByLocation[location] = next;
  if (previous !== next) {
    const delta = next - previous;
    const movementType = type === "inventory" && delta < 0 ? "consumption" : type;
    addMovement({
      delta,
      type: movementType,
      itemId: item.id,
      itemName: item.name,
      category: item.category,
      location,
      ort: storageFromLabel(location).ort,
      before: previous,
      after: next,
      displayDelta: deltaLabel,
    });
  }
  saveState();
  render();
}

function addMovement(movement) {
  const timestamp = new Date();
  const displayDelta =
    movement.displayDelta || `${movement.delta > 0 ? "+" : ""}${movement.delta}`;
  const type = movement.type || movementTypeFromDelta(movement.delta);
  const entry = {
    id: crypto.randomUUID(),
    timestamp: timestamp.toISOString(),
    delta: movement.delta,
    type,
    itemId: movement.itemId,
    itemName: movement.itemName,
    category: movement.category,
    location: movement.location,
    ort: movement.ort || storageFromLabel(movement.location).ort,
    before: movement.before,
    after: movement.after,
    label: `${timestamp.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}: ${movementTypeLabel(type)} ${displayDelta} ${movement.itemName} · ${movement.location}`,
  };
  state.movements = [entry, ...(state.movements || [])].slice(0, 1000);
}

function movementLabel(movement) {
  return typeof movement === "string" ? movement : movement.label || "";
}

function openItemDialog(item = null) {
  $("#itemForm").reset();
  $("#itemId").value = item?.id || "";
  $("#itemName").value = item?.name || "";
  $("#itemCategory").value = item?.category || "";
  $("#itemBrand").value = item?.brand || "";
  $("#itemPackageQuantity").value = item?.packageQuantity ?? "";
  $("#itemPackageUnit").value = item?.packageUnit || splitPackageSize(item?.packageSize || "").unit;
  $("#itemMin").value = item?.minStock ?? "";
  $("#itemMax").value = item?.maxStock ?? "";
  renderStorageLocationRows(
    item
      ? itemStorageLocations(item).map((entry) => ({
          ...entry,
          stock: numberOrZero(item.stockByLocation?.[storageLabel(entry)]),
        }))
      : [],
  );
  $("#itemNotes").value = item?.notes || "";
  $("#deleteItem").hidden = !item;
  $("#dialogTitle").textContent = item ? "Artikel bearbeiten" : "Artikel anlegen";
  $("#itemDialog").showModal();
}

function saveItemFromDialog(event) {
  event?.preventDefault();
  const id = $("#itemId").value || crypto.randomUUID();
  const existing = state.items.find((item) => item.id === id);
  const createdFromInventory = !existing && currentPage === "inventory";
  const storageRows = readStorageLocationRows();
  const storageLocations = storageRows.map(({ stock, ...entry }) => entry);
  const locations = storageLocations.map(storageLabel);
  const stockByLocation = {};
  locations.forEach((location, index) => {
    stockByLocation[location] = storageRows[index]?.stock ?? existing?.stockByLocation?.[location] ?? 0;
  });
  const packageQuantity = $("#itemPackageQuantity").value === "" ? null : numberOrZero($("#itemPackageQuantity").value);
  const packageUnit = $("#itemPackageUnit").value.trim();
  const nextItem = {
    id,
    category: $("#itemCategory").value.trim(),
    colorCode: "",
    name: $("#itemName").value.trim(),
    brand: $("#itemBrand").value.trim(),
    packageQuantity,
    packageUnit,
    packageSize: formatPackageSize(packageQuantity, packageUnit),
    packageDimensions: existing?.packageDimensions || "",
    minStock: $("#itemMin").value === "" ? null : numberOrZero($("#itemMin").value),
    maxStock: $("#itemMax").value === "" ? null : numberOrZero($("#itemMax").value),
    link: existing?.link || "",
    storageLocations,
    locations,
    stockByLocation,
    notes: $("#itemNotes").value.trim(),
    locationIssue: existing?.locationIssue && $("#itemNotes").value.includes("Entfernter Lagerplatz"),
    removedStorageLocations: existing?.removedStorageLocations || [],
  };
  if (existing) {
    locations.forEach((location) => {
      const previous = numberOrZero(existing.stockByLocation?.[location]);
      const next = numberOrZero(stockByLocation[location]);
      if (previous !== next) {
        addMovement({
          delta: next - previous,
          type: next - previous < 0 ? "consumption" : "inventory",
          itemId: nextItem.id,
          itemName: nextItem.name,
          category: nextItem.category,
          location,
          ort: storageFromLabel(location).ort,
          before: previous,
          after: next,
        });
      }
    });
    Object.assign(existing, nextItem);
  } else {
    state.items.unshift(nextItem);
  }
  state.categories = uniqueList([...(state.categories || []), nextItem.category]);
  state.locations = uniqueList([...(state.locations || []), ...storageLocations.map((entry) => entry.ort)]);
  if (createdFromInventory) {
    inventoryFilters = { query: "", category: "Alle", location: "Alle" };
    highlightedInventoryItemId = nextItem.id;
  }
  saveState();
  $("#itemDialog").close();
  render();
}

function deleteCurrentItem() {
  const id = $("#itemId").value;
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  const confirmed = window.confirm(`"${item.name}" löschen?`);
  if (!confirmed) return;
  state.items = state.items.filter((entry) => entry.id !== id);
  saveState();
  $("#itemDialog").close();
  render();
}

function exportJson() {
  downloadFile(`lagerbestand-${dateStamp()}.json`, JSON.stringify(state, null, 2), "application/json");
}

function exportCsv() {
  const rows = [["Kategorie", "Material", "Marke", "Packungsgröße", "Lagerort", "Bestand", "Mindestbestand", "Maximalbestand", "Notiz"]];
  state.items.forEach((item) => {
    const locations = item.locations?.length ? item.locations : [""];
    locations.forEach((location) => {
      rows.push([
        item.category,
        item.name,
        item.brand,
        item.packageSize,
        location,
        location ? numberOrZero(item.stockByLocation?.[location]) : "",
        item.minStock ?? "",
        item.maxStock ?? "",
        item.notes ?? "",
      ]);
    });
  });
  const csv = rows.map((row) => row.map(csvCell).join(";")).join("\n");
  downloadFile(`lagerbestand-${dateStamp()}.csv`, csv, "text/csv;charset=utf-8");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function downloadFile(filename, contents, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function importJsonFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported.items)) throw new Error("items missing");
      state = {
        items: imported.items,
        categories: imported.categories || [],
        locations: imported.locations || [],
        movements: imported.movements || [],
      };
      state = normalizeState(state);
      saveState();
      render();
    } catch {
      window.alert("Die JSON-Datei konnte nicht importiert werden.");
    }
  };
  reader.readAsText(file);
}

function resetData() {
  const confirmed = window.confirm("Startdaten neu laden und lokale Änderungen ersetzen?");
  if (!confirmed) return;
  localStorage.removeItem(STORAGE_KEY);
  state = loadState();
  filters = { query: "", category: "Alle", location: "Alle", status: "all" };
  analysisFilters = defaultAnalysisFilters();
  selectedItemId = null;
  $("#searchInput").value = "";
  saveState();
  render();
}

function saveOptions(event) {
  event.preventDefault();
  const previousLocations = configuredLocations();
  state.categories = uniqueList($("#categoryListInput").value.split("\n"));
  const nextLocations = uniqueList($("#locationListInput").value.split("\n"));
  const removedLocations = previousLocations.filter((location) => !nextLocations.includes(location));
  state.locations = nextLocations;
  if (removedLocations.length) {
    removeInvalidStorageLocations(removedLocations);
  }
  resetPageState();
  currentPage = "overview";
  saveState();
  render();
}

function removeInvalidStorageLocations(removedLocations) {
  const removedSet = new Set(removedLocations);
  state.items.forEach((item) => {
    const keptStorage = [];
    const removedStorage = [];
    itemStorageLocations(item).forEach((entry) => {
      const label = storageLabel(entry);
      const stock = numberOrZero(item.stockByLocation?.[label]);
      if (removedSet.has(entry.ort)) {
        removedStorage.push({ ...entry, label, stock });
      } else {
        keptStorage.push(entry);
      }
    });
    if (!removedStorage.length) return;
    item.storageLocations = keptStorage;
    item.locations = keptStorage.map(storageLabel);
    item.stockByLocation = Object.fromEntries(
      item.locations.map((location) => [location, numberOrZero(item.stockByLocation?.[location])]),
    );
    item.locationIssue = true;
    item.removedStorageLocations = uniqueList([
      ...(item.removedStorageLocations || []),
      ...removedStorage.map((entry) => `${entry.label}${entry.stock ? ` (Bestand ${entry.stock})` : ""}`),
    ]);
    item.notes = appendRemovedLocationNote(item.notes, removedStorage);
  });
}

function appendRemovedLocationNote(notes, removedStorage) {
  const existing = String(notes || "").trim();
  const lines = removedStorage.map((entry) => {
    const stockText = entry.stock ? `, letzter Bestand: ${entry.stock}` : "";
    return `- ${entry.label}${stockText}`;
  });
  const block = [`Entfernter Lagerplatz wegen geänderter Lagerort-Liste:`, ...lines].join("\n");
  if (existing.includes(block)) return existing;
  return [existing, block].filter(Boolean).join("\n\n");
}

function openPage(page) {
  if (page !== currentPage && !handlePendingInventoryDraft()) return;
  resetPageState();
  currentPage = page;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetPageState() {
  filters = { query: "", category: "Alle", location: "Alle", status: "all" };
  inventoryFilters = { query: "", category: "Alle", location: "Alle" };
  analysisFilters = defaultAnalysisFilters();
  selectedItemId = null;
  selectedAnalysisItemId = null;
  returnPageAfterProduct = null;
  const searchInput = $("#searchInput");
  if (searchInput) searchInput.value = "";
  const inventorySearchInput = $("#inventorySearchInput");
  if (inventorySearchInput) inventorySearchInput.value = "";
}

function handlePendingInventoryDraft() {
  if (!inventoryDirty) return true;
  const saveDraft = window.confirm("Es gibt unbestätigte Inventur-Eingaben. Inventur jetzt speichern?");
  if (saveDraft) {
    confirmInventoryDraft();
    return true;
  }
  const discardDraft = window.confirm("Inventur-Eingaben verwerfen? Wenn du abbrichst, bleibst du im aktuellen Inventurstand.");
  if (discardDraft) {
    discardInventoryDraft();
    return true;
  }
  return false;
}

function discardInventoryDraft() {
  inventoryDraft = {};
  inventoryDirty = false;
}

document.addEventListener("click", (event) => {
  const actionTarget = event.target.closest("[data-action]");
  const action = actionTarget?.dataset.action;
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    openPage(pageButton.dataset.page);
    $("#menuDialog").close();
    return;
  }

  const summaryButton = event.target.closest("[data-summary-filter]");
  if (summaryButton) {
    currentPage = "inventoryList";
    selectedItemId = null;
    const value = summaryButton.dataset.summaryFilter;
    if (value === "low") {
      filters.status = "low";
    } else if (value === "locations") {
      filters.location = "Alle";
      $("#locationFilter").focus();
    } else {
      filters = { ...filters, status: "all", category: "Alle", location: "Alle" };
    }
    render();
    return;
  }

  if (event.target.closest("#brandHome")) {
    if (!handlePendingInventoryDraft()) return;
    resetPageState();
    currentPage = "overview";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (action === "close-analysis-detail") {
    selectedAnalysisItemId = null;
    render();
    return;
  }

  const analysisItemButton = event.target.closest("[data-analysis-item-id]");
  if (analysisItemButton) {
    selectedAnalysisItemId = analysisItemButton.dataset.analysisItemId;
    render();
    $("#analysisTables").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const inventoryItemButton = event.target.closest("[data-open-item-id]");
  if (inventoryItemButton) {
    returnPageAfterProduct = currentPage === "inventory" ? "inventory" : currentPage === "overview" ? "overview" : null;
    currentPage = "inventoryList";
    selectedItemId = inventoryItemButton.dataset.openItemId;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const removeAnalysisItem = event.target.closest("[data-remove-analysis-item]");
  if (removeAnalysisItem) {
    analysisFilters.itemIds = analysisFilters.itemIds.filter((id) => id !== removeAnalysisItem.dataset.removeAnalysisItem);
    selectedAnalysisItemId = null;
    render();
    return;
  }

  if (action === "close-item-dialog") {
    $("#itemDialog").close();
    return;
  }

  const card = event.target.closest(".material-card");
  if (action === "remove-storage-location") {
    const row = event.target.closest(".storage-location-row");
    row?.remove();
    if (!$("#storageLocationRows").children.length) renderStorageLocationRows([]);
    return;
  }
  if (card && action) {
    const itemId = card.dataset.id;
    const item = state.items.find((entry) => entry.id === itemId);
    if (action === "edit") openItemDialog(item);
    if (action === "increment" || action === "decrement") {
      const row = event.target.closest(".stock-row");
      const location = row.dataset.location;
      const current = numberOrZero(item.stockByLocation?.[location]);
      const next = Math.max(0, current + (action === "increment" ? 1 : -1));
      updateStock(itemId, location, next, action === "increment" ? "+1" : "-1", action === "increment" ? "input" : "inventory");
    }
    return;
  }

  if ((action === "increment" || action === "decrement") && selectedItemId) {
    const item = state.items.find((entry) => entry.id === selectedItemId);
    const row = event.target.closest(".stock-row");
    if (!item || !row) return;
    const location = row.dataset.location;
    const current = numberOrZero(item.stockByLocation?.[location]);
    const next = Math.max(0, current + (action === "increment" ? 1 : -1));
    updateStock(selectedItemId, location, next, action === "increment" ? "+1" : "-1", action === "increment" ? "input" : "inventory");
    return;
  }

  if (card) {
    selectedItemId = card.dataset.id;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (action === "back-to-list") {
    selectedItemId = null;
    if (returnPageAfterProduct) {
      currentPage = returnPageAfterProduct;
      returnPageAfterProduct = null;
    }
    render();
    return;
  }

  if (action === "save-product-booking" && selectedItemId) {
    saveProductBooking();
    return;
  }

  if (action === "open-product-analysis" && selectedItemId) {
    openProductAnalysis(selectedItemId);
    return;
  }

  const productView = event.target.closest("#productView");
  if (productView && action === "edit") {
    const item = state.items.find((entry) => entry.id === selectedItemId);
    openItemDialog(item);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "statusFilter") {
    filters.status = event.target.value;
    selectedItemId = null;
    render();
  }
  if (event.target.id === "categoryFilter") {
    filters.category = event.target.value;
    selectedItemId = null;
    render();
  }
  if (event.target.id === "locationFilter") {
    filters.location = event.target.value;
    selectedItemId = null;
    render();
  }
  if (event.target.id === "inventoryCategoryFilter") {
    inventoryFilters.category = event.target.value;
    render();
  }
  if (event.target.id === "inventoryLocationFilter") {
    inventoryFilters.location = event.target.value;
    render();
  }
  if (event.target.id === "analysisStatusFilter") {
    analysisFilters.status = event.target.value;
    selectedAnalysisItemId = null;
    render();
  }
  if (event.target.id === "analysisCategoryFilter") {
    analysisFilters.category = event.target.value;
    selectedAnalysisItemId = null;
    render();
  }
  if (event.target.id === "analysisLocationFilter") {
    analysisFilters.location = event.target.value;
    selectedAnalysisItemId = null;
    render();
  }
  if (event.target.id === "analysisPeriodFilter") {
    analysisFilters.period = event.target.value;
    if (analysisFilters.period !== "custom") {
      const range = presetDateRange(analysisFilters.period);
      analysisFilters.from = range.from;
      analysisFilters.to = range.to;
    }
    selectedAnalysisItemId = null;
    render();
  }
  if (event.target.id === "analysisFromDate") {
    analysisFilters.period = "custom";
    analysisFilters.from = event.target.value;
    selectedAnalysisItemId = null;
    render();
  }
  if (event.target.id === "analysisToDate") {
    analysisFilters.period = "custom";
    analysisFilters.to = event.target.value;
    selectedAnalysisItemId = null;
    render();
  }
  if (event.target.dataset.analysisItemOption) {
    const itemId = event.target.dataset.analysisItemOption;
    analysisFilters.itemIds = event.target.checked
      ? uniqueList([...analysisFilters.itemIds, itemId])
      : analysisFilters.itemIds.filter((id) => id !== itemId);
    selectedAnalysisItemId = null;
    render();
  }
  if (event.target.dataset.storageField) {
    return;
  }
  if (event.target.dataset.inventoryCount) {
    updateInventoryDraft(event.target.dataset.inventoryCount, event.target.value);
    render();
    return;
  }
  if (event.target.dataset.action === "set-stock") {
    const card = event.target.closest(".material-card");
    const row = event.target.closest(".stock-row");
    const itemId = card?.dataset.id || selectedItemId;
    updateStock(itemId, row.dataset.location, event.target.value, null, "inventory");
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "inventorySearchInput") {
    inventoryFilters.query = event.target.value;
    renderInventory();
    return;
  }
  if (event.target.id === "analysisItemSearch") {
    analysisFilters.itemQuery = event.target.value;
    renderAnalysisItemPicker();
    return;
  }
  if (event.target.dataset.inventoryCount) {
    updateInventoryDraft(event.target.dataset.inventoryCount, event.target.value);
  }
});

document.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("[data-analysis-item-id], [data-open-item-id]");
  if (!row || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  if (row.dataset.analysisItemId) {
    selectedAnalysisItemId = row.dataset.analysisItemId;
    render();
    $("#analysisTables").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  currentPage = "overview";
  selectedItemId = row.dataset.openItemId;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("#searchInput").addEventListener("input", (event) => {
  filters.query = event.target.value;
  renderMaterials();
});

$("#addItem").addEventListener("click", () => openItemDialog());
$("#addInventoryItem").addEventListener("click", () => openItemDialog());
$("#addStorageLocation").addEventListener("click", () => {
  const entries = readStorageLocationRows();
  entries.push({ ort: allLocations()[0] || "", regal: null, platz: null });
  renderStorageLocationRows(entries);
});
$("#openMenu").addEventListener("click", () => $("#menuDialog").showModal());
$("#itemForm").addEventListener("submit", (event) => event.preventDefault());
$("#saveItem").addEventListener("click", () => {
  const form = $("#itemForm");
  if (!form.reportValidity()) return;
  saveItemFromDialog();
});
$("#confirmInventory").addEventListener("click", () => {
  if (!inventoryDirty) return;
  const entries = inventoryDraftEntries().length;
  const changes = inventoryDraftChanges().length;
  const confirmed = window.confirm(`${entries} gezählte Artikel übernehmen (${changes} mit Bestandsänderung)?`);
  if (!confirmed) return;
  confirmInventoryDraft();
});
$("#optionsForm").addEventListener("submit", saveOptions);
$("#deleteItem").addEventListener("click", deleteCurrentItem);
$("#exportJson").addEventListener("click", exportJson);
$("#exportCsv").addEventListener("click", exportCsv);
$("#importJson").addEventListener("change", (event) => importJsonFile(event.target.files[0]));
$("#resetData").addEventListener("click", resetData);
$("#authForm").addEventListener("submit", signIn);
$("#signUpButton").addEventListener("click", signUp);
$("#logoutButton").addEventListener("click", signOut);

render();
clearOldAppCaches();
initializeCloudState();

async function clearOldAppCaches() {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("lagerung-materialien-")).map((key) => caches.delete(key)));
  }
}
