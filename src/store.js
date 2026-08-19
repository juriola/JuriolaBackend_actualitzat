const seed = {
  users: [],

  boats: [
    {
      id: 'juriola',
      name: 'Juriola',

      // Credencials Tuya del projecte (úniques i
      // compartides per tots els clients). El que
      // diferencia cada vaixell és el seu UID.
      tuya: {
        uid: null
      },

      devices: [],

      gadgets: [],

      victronDevices: []
    }
  ]
};


// ─────────────────────────────────────────────
// PERSISTÈNCIA: UPSTASH REDIS (gratuït i persistent)
// ─────────────────────────────────────────────
//
// Render Free no permet discs persistents: qualsevol fitxer local
// (com abans data/db.json) desapareix a cada reinici/spin-down. Per
// no dependre de cap pla de pagament, la "base de dades" ara viu a
// Upstash (Redis amb API REST, gratuït) com UN sol valor JSON.
//
// Per no haver de convertir totes les funcions d'aquest fitxer (i
// totes les rutes de server.js) a async, es manté una còpia en
// memòria (`dbCache`) que és amb qui treballen `load()`/`save()` de
// forma síncrona, tal com sempre. `save()` sí que dispara en
// segon pla (sense esperar) l'escriptura real a Upstash.
//
// Cal definir aquestes variables d'entorn a Render:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DB_KEY = 'juriola:db';

let dbCache = null;

async function fetchFromUpstash() {
  const res = await fetch(
    `${UPSTASH_URL}/get/${DB_KEY}`,
    { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
  );

  if (!res.ok) {
    throw new Error(`Upstash GET ha fallat: ${res.status}`);
  }

  const data = await res.json();

  return data.result
    ? JSON.parse(data.result)
    : null;
}


async function pushToUpstash(db) {
  const res = await fetch(
    `${UPSTASH_URL}/set/${DB_KEY}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify(db),
    }
  );

  // Abans només es capturaven errors de xarxa (fetch rebutjat), però un
  // 4xx/5xx d'Upstash (per exemple, token caducat) també ha de comptar
  // com a fallada, o si no la resta del sistema pensa que s'ha desat bé
  // quan en realitat no.
  if (!res.ok) {
    throw new Error(`Upstash SET ha fallat: ${res.status}`);
  }
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Intenta `fetchFromUpstash()` fins a 3 cops (amb una petita espera
 * entre intents) abans de rendir-se. Els contenidors de Render es
 * poden despertar amb la xarxa encara no del tot preparada; un sol
 * intent fallit no hauria de deixar una instància sencera "orfe" (en
 * memòria buida) fins al proper reinici.
 */
async function fetchFromUpstashWithRetries(maxAttempts = 3) {
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchFromUpstash();
    } catch (err) {
      lastErr = err;
      console.error(
        `[store] Intent ${attempt}/${maxAttempts} de llegir Upstash ha fallat:`,
        err
      );

      if (attempt < maxAttempts) {
        await sleep(500 * attempt); // 500ms, 1000ms...
      }
    }
  }

  throw lastErr;
}


/**
 * Cal cridar-la un sol cop, a l'arrencada del servidor (server.js),
 * abans d'acceptar cap petició. Carrega les dades reals des
 * d'Upstash; si encara no n'hi ha (primer arrencada de veritat, la
 * clau no existeix), sembra amb `seed` i el puja.
 *
 * ⚠️ CORRECCIÓ IMPORTANT: abans, si `fetchFromUpstash()` fallava per
 * QUALSEVOL motiu (per exemple, un simple error de xarxa transitori
 * durant l'arrencada del contenidor), es tractava exactament igual
 * que "la clau no existeix" -> es carregava el `seed` buit EN
 * MEMÒRIA *i, a més, es tornava a pujar aquest seed buit a Upstash*,
 * esborrant per sempre qualsevol dada real que hi hagués (usuaris,
 * gadgets, configuració Victron...). Com que Render pot reiniciar el
 * contenidor sovint (cada `git push`, per l'"spin-down" del pla
 * gratuït, etc.), n'hi havia prou amb un sol reinici amb mala sort
 * perquè es perdés tota la base de dades sense cap avís.
 *
 * Ara es distingeixen els dos casos: només se sembra Upstash quan el
 * `fetch` ha anat BÉ i ha confirmat que la clau no existeix; si el
 * `fetch` falla (fins i tot després de reintentar-ho unes quantes
 * vegades), aquesta instància funciona en memòria amb un seed buit
 * (mode degradat, es queixa fort als logs) però MAI escriu res a
 * Upstash — la propera vegada que arrenqui i la xarxa vagi bé,
 * tornarà a llegir les dades reals sense haver-les perdut.
 */
export async function initDb() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error(
      '[store] Falten UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. ' +
      'Les dades NOMÉS viuran en memòria i es perdran al reiniciar.'
    );
    dbCache = structuredClone(seed);
    dbCache.users = [];
    return;
  }

  let remote = null;
  let fetchFailed = false;

  try {
    remote = await fetchFromUpstashWithRetries();
  } catch (err) {
    fetchFailed = true;
    console.error(
      '[store] CRÍTIC: no s\'ha pogut llegir Upstash a l\'arrencada, ' +
      'ni tan sols reintentant-ho. Per seguretat NO es sobreescriurà ' +
      'la base de dades remota amb el seed buit: aquesta instància ' +
      'funcionarà en memòria en mode degradat fins al proper reinici.',
      err
    );
  }

  dbCache = remote || structuredClone(seed);

  if (!Array.isArray(dbCache.users)) {
    dbCache.users = [];
  }

  // Només sembrem Upstash quan estem SEGURS que la clau encara no
  // existia (fetch ha anat bé i ha tornat null) -- mai quan el fetch
  // ha fallat, o un simple error de xarxa esborraria dades reals.
  if (!remote && !fetchFailed) {
    pushToUpstash(dbCache).catch(err => {
      console.error('[store] Error sembrant Upstash a la primera arrencada:', err);
    });
  }
}


function load() {
  if (!dbCache) {
    throw new Error(
      "store.js: cal cridar initDb() a l'arrencada (server.js) abans de fer servir cap funció."
    );
  }

  return dbCache;
}


// Es guarda sempre la promesa de la darrera escriptura a Upstash. La
// majoria de rutes NO en fan `await` (per no alentir cada resposta), però
// les rutes que et donen una confirmació explícita a l'usuari (com
// "ok:true" a victron-config) SÍ que hi han de fer `await` amb
// `waitForPersist()`, per no dir "desat" quan en realitat encara no ho
// estava de veritat a Upstash.
let lastPersist = Promise.resolve();

function save(db) {
  dbCache = db;

  lastPersist = pushToUpstash(db).catch(err => {
    console.error('[store] Error desant a Upstash:', err);
    throw err;
  });

  // Evitem l'avís de "unhandled promise rejection" quan ningú fa `await`
  // d'aquesta escriptura concreta; qui sí que en faci `await` via
  // `waitForPersist()` rebrà igualment l'error (cada `.catch()` es
  // gestiona independentment sobre la mateixa promesa).
  lastPersist.catch(() => {});

  return lastPersist;
}


/**
 * Retorna una promesa que es resol quan l'última escriptura pendent a
 * Upstash ha acabat (i es rebutja si ha fallat). Fer-hi `await` just
 * abans de respondre "ok:true" a l'usuari en una ruta d'escriptura
 * important evita confirmar un desat que en realitat s'ha perdut
 * silenciosament pel camí (per exemple, si Render reinicia el
 * contenidor abans que acabi la petició de xarxa cap a Upstash).
 */
export function waitForPersist() {
  return lastPersist;
}


// ─────────────────────────────────────────────
// BOATS
// ─────────────────────────────────────────────

export function listBoats() {
  return load().boats.map(
    ({ devices, gadgets, ...boat }) => boat
  );
}


export function getBoat(id) {
  return load().boats.find(
    boat => boat.id === id
  );
}


export function addBoat({ id, name }) {
  const db = load();

  if (
    db.boats.some(
      boat => boat.id === id
    )
  ) {
    throw new Error(
      'Ja existeix aquest vaixell'
    );
  }

  const boat = {
    id,
    name,
    tuya: {
      uid: null
    },
    devices: [],
    gadgets: []
  };

  db.boats.push(boat);

  save(db);

  return boat;
}


// ─────────────────────────────────────────────
// DEVICES
// ─────────────────────────────────────────────

export function getDevices(boatId) {
  return getBoat(boatId)?.devices || null;
}


export function getDevice(
  boatId,
  deviceId
) {
  return getDevices(boatId)
    ?.find(
      device => device.id === deviceId
    );
}


// ─────────────────────────────────────────────
// AFEGIR DEVICE (des del cat\u00e0leg d'instruments Tuya)
// ─────────────────────────────────────────────
//
// Quan l'usuari tria un instrument Tuya per afegir-lo al panell,
// primer cal un "device" local (amb id propi) que el representi,
// perqu\u00e8 els gadgets i els endpoints de status/command treballen
// sobre devices locals, no directament sobre IDs de Tuya.
//
// Si ja existeix un device local amb aquest tuya_device_id, el
// reutilitzem (evita duplicar-lo si l'usuari afegeix dos gadgets
// del mateix aparell, p. ex. temperatura + humitat del mateix sensor).
//

export function getOrCreateDeviceByTuyaId(
  boatId,
  { tuyaDeviceId, name, params }
) {
  const db = load();

  const boat = db.boats.find(
    b => b.id === boatId
  );

  if (!boat) {
    return null;
  }

  const existing = boat.devices.find(
    d => d.tuya_device_id === tuyaDeviceId
  );

  if (existing) {
    return existing;
  }

  const device = {
    id: `device-${Date.now()}`,
    name: name || tuyaDeviceId,
    type: 'device',
    source: 'tuya',
    tuya_device_id: tuyaDeviceId,
    params: params || {},
  };

  boat.devices.push(device);

  save(db);

  return device;
}


/**
 * Càmera (o altre dispositiu) que NO passa per Tuya: es guarda la URL
 * RTSP directament. Útil per càmeres genèriques (YESYAMO i similars)
 * que exposen vídeo per RTSP a la xarxa local del vaixell.
 */
export function addRtspDevice(
  boatId,
  { name, rtspUrl }
) {
  const db = load();

  const boat = db.boats.find(
    b => b.id === boatId
  );

  if (!boat) {
    return null;
  }

  const device = {
    id: `device-${Date.now()}`,
    name: name || 'Càmera',
    type: 'device',
    source: 'rtsp',
    tuya_device_id: null,
    params: { url: rtspUrl },
  };

  boat.devices.push(device);

  save(db);

  return device;
}


// ─────────────────────────────────────────────
// VICTRON (dispositius BLE via ESP32 gateway)
// ─────────────────────────────────────────────
//
// A diferència de Tuya, aquí no hi ha cap API cloud: les dades venen
// d'un ESP32 al vaixell que escolta el Bluetooth del dispositiu Victron
// (SmartSolar, etc.) i les reenvia xifrades al backend (victronDecoder.js
// les desxifra). Per poder-ho fer calen la MAC del dispositiu i la seva
// clau de xifratge (treta manualment de VictronConnect).
//

export function configureVictronDevice(
  boatId,
  { mac, encryptionKey, name }
) {
  const db = load();

  const boat = db.boats.find(
    b => b.id === boatId
  );

  if (!boat) {
    return null;
  }

  if (!Array.isArray(boat.victronDevices)) {
    boat.victronDevices = [];
  }

  const normalizedMac = mac.toUpperCase();

  let config = boat.victronDevices.find(
    d => d.mac === normalizedMac
  );

  if (config) {
    config.encryptionKey = encryptionKey;
    config.name = name || config.name;
  } else {
    config = {
      mac: normalizedMac,
      encryptionKey,
      name: name || 'Victron SmartSolar'
    };

    boat.victronDevices.push(config);
  }

  save(db);

  return config;
}


export function getVictronDeviceConfig(boatId, mac) {
  const boat = getBoat(boatId);

  if (!boat) {
    return null;
  }

  const normalizedMac = mac.toUpperCase();

  return (boat.victronDevices || []).find(
    d => d.mac === normalizedMac
  ) || null;
}


/**
 * Desa la lectura més recent d'un dispositiu Victron com un 'device' més
 * del vaixell (mateix esperit que els devices Tuya/RTSP), creant-lo si
 * encara no existeix.
 */
export function updateVictronReading(boatId, mac, status) {
  const db = load();

  const boat = db.boats.find(
    b => b.id === boatId
  );

  if (!boat) {
    return null;
  }

  const normalizedMac = mac.toUpperCase();

  let device = boat.devices.find(
    d => d.source === 'victron' && d.mac === normalizedMac
  );

  if (!device) {
    const config = (boat.victronDevices || []).find(
      d => d.mac === normalizedMac
    );

    device = {
      id: `device-victron-${normalizedMac.replace(/:/g, '')}`,
      name: config?.name || 'Victron SmartSolar',
      type: 'device',
      source: 'victron',
      mac: normalizedMac,
      tuya_device_id: null,
      params: {},
    };

    boat.devices.push(device);
  }

  device.lastUpdate = new Date().toISOString();
  device.status = status;

  save(db);

  return device;
}


// ─────────────────────────────────────────────
// UID TUYA (per vaixell/client)
// ─────────────────────────────────────────────
//
// El projecte Tuya (client_id/secret) és únic i
// compartit (.env). El que distingeix cada vaixell
// és el UID del seu compte d'app, obtingut en
// vincular-lo al projecte (Devices > Link Tuya App
// Account, dins iot.tuya.com).
//

export function getBoatTuyaUid(boatId) {
  const boat = getBoat(boatId);

  return boat?.tuya?.uid || null;
}


export function setBoatTuyaUid(boatId, uid) {
  const db = load();

  const boat = db.boats.find(
    b => b.id === boatId
  );

  if (!boat) {
    return null;
  }

  boat.tuya = {
    ...(boat.tuya || {}),
    uid
  };

  save(db);

  return boat.tuya;
}


// ─────────────────────────────────────────────
// INSTRUMENTS
// ─────────────────────────────────────────────
//
// Aquesta funció construeix la llista d'instruments
// que ja coneixem del vaixell.
//
// Més endavant aquesta font serà:
// Tuya + Victron + NMEA
//
// Ara mateix:
// Tuya
//

// ─────────────────────────────────────────────
// CAMPS VICTRON PER TIPUS (per generar instruments i llegir l'estat)
// ─────────────────────────────────────────────
//
// Cada "kind" que pot tornar victronDecoder.js exposa uns quants camps
// numèrics interessants per mostrar al panell. Aquesta llista és la
// font única tant per als instruments afegibles com per a la consulta
// d'estat en viu — així sempre van coordinats.

export const VICTRON_FIELDS_BY_KIND = {
  solar_charger: [
    { code: 'batteryVoltage', unit: 'V', label: 'Voltatge bateria' },
    { code: 'batteryCurrent', unit: 'A', label: 'Corrent bateria' },
    { code: 'solarPower', unit: 'W', label: 'Potència solar' },
    { code: 'yieldToday', unit: 'kWh', label: 'Producció avui' },
    { code: 'loadCurrent', unit: 'A', label: 'Corrent de càrrega' },
  ],
  ac_charger: [
    { code: 'batteryVoltage1', unit: 'V', label: 'Voltatge bateria 1' },
    { code: 'batteryCurrent1', unit: 'A', label: 'Corrent bateria 1' },
    { code: 'batteryVoltage2', unit: 'V', label: 'Voltatge bateria 2' },
    { code: 'batteryCurrent2', unit: 'A', label: 'Corrent bateria 2' },
  ],
  dc_dc_converter: [
    { code: 'outputVoltage', unit: 'V', label: 'Voltatge sortida' },
    { code: 'outputCurrent', unit: 'A', label: 'Corrent sortida' },
    { code: 'inputVoltage', unit: 'V', label: 'Voltatge entrada' },
    { code: 'inputCurrent', unit: 'A', label: 'Corrent entrada' },
  ],
};


/**
 * Converteix l'últim estat desat d'un dispositiu Victron (device.status,
 * tal com el desa updateVictronReading) en la mateixa forma [{code,
 * value}] que ja retorna Tuya — així l'endpoint /status i l'app no han
 * de saber d'on ve cada dispositiu.
 */
export function getVictronDeviceStatusItems(device) {
  const kind = device?.status?.kind;
  const fields = VICTRON_FIELDS_BY_KIND[kind];

  if (!fields) {
    return [];
  }

  return fields
    .filter(f => device.status[f.code] !== undefined && device.status[f.code] !== null)
    .map(f => ({ code: f.code, value: device.status[f.code] }));
}


/**
 * Un dispositiu Victron es considera "online" si ha enviat una lectura
 * vàlida (tipus 0x10) en els últims 5 minuts. Els reinicis preventius
 * de l'escaneig BLE al firmware ESP32 són cada 3 minuts, així que
 * aquest marge dona prou joc perquè no aparegui com a "offline" entre
 * cicles normals de funcionament.
 */
const VICTRON_ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

function isVictronDeviceOnline(device) {
  if (!device.lastUpdate) {
    return false;
  }

  const ageMs = Date.now() - new Date(device.lastUpdate).getTime();
  return ageMs >= 0 && ageMs < VICTRON_ONLINE_THRESHOLD_MS;
}


/**
 * Instruments (capacitats afegibles) generats només des dels
 * dispositius Victron ja coneguts d'un vaixell.
 */
export function getVictronInstruments(boatId) {
  const devices = getDevices(boatId) || [];
  const instruments = [];

  for (const device of devices) {
    if (device.source !== 'victron') {
      continue;
    }

    const kind = device?.status?.kind;
    const fields = VICTRON_FIELDS_BY_KIND[kind] || [];
    const online = isVictronDeviceOnline(device);

    for (const field of fields) {
      if (device.status[field.code] === undefined || device.status[field.code] === null) {
        continue;
      }

      instruments.push({
        id: `${device.id}:${field.code}`,
        source: 'victron',
        deviceId: device.id,
        tuyaDeviceId: null,
        deviceName: device.name,
        code: field.code,
        type: 'valor', // suggereix Voltímetre/Amperímetre a l'app, l'usuari ho pot canviar
        unit: field.unit,
        value: device.status[field.code],
        online,
        title: `${device.name} · ${field.label}`,
      });
    }
  }

  return instruments;
}


export function getLocalInstruments(
  boatId
) {
  const devices = getDevices(boatId);

  if (!devices) {
    return null;
  }

  const instruments = getVictronInstruments(boatId);

  for (const device of devices) {

    if (
      device.source !== 'tuya'
    ) {
      continue;
    }

    const params =
      device.params || {};

    // Temperatura
    if (params.temperature_code) {
      instruments.push({
        id:
          `${device.id}:${params.temperature_code}`,

        source: 'tuya',

        deviceId: device.id,

        tuyaDeviceId:
          device.tuya_device_id,

        deviceName:
          device.name,

        code:
          params.temperature_code,

        type:
          'temperatura',

        unit:
          '°C',

        title:
          device.name
      });
    }


    // Humitat
    if (params.humidity_code) {
      instruments.push({
        id:
          `${device.id}:${params.humidity_code}`,

        source: 'tuya',

        deviceId: device.id,

        tuyaDeviceId:
          device.tuya_device_id,

        deviceName:
          device.name,

        code:
          params.humidity_code,

        type:
          'humitat',

        unit:
          '%',

        title:
          device.name
      });
    }


    // Interruptor
    if (params.command_code) {
      instruments.push({
        id:
          `${device.id}:${params.command_code}`,

        source: 'tuya',

        deviceId: device.id,

        tuyaDeviceId:
          device.tuya_device_id,

        deviceName:
          device.name,

        code:
          params.command_code,

        type:
          'interruptor',

        unit:
          '',

        title:
          device.name
      });
    }
  }

  return instruments;
}


// ─────────────────────────────────────────────
// GRAELLA (SNAP GRID)
// ─────────────────────────────────────────────
//
// El panell es col·loca sobre una graella lògica de
// GRID_COLUMNS columnes (files il·limitades). Cada
// gadget ocupa unes cel·les enteres: col/row (cantonada
// superior-esquerra) + colSpan/rowSpan (mida). Així el
// panell es pot pintar a qualsevol pantalla sense
// dependre de píxels concrets.
//

export const GRID_COLUMNS = 4;


function cellsOf(g) {
  const cells = [];

  for (let dc = 0; dc < (g.colSpan || 1); dc++) {
    for (let dr = 0; dr < (g.rowSpan || 1); dr++) {
      cells.push(`${g.col + dc}:${g.row + dr}`);
    }
  }

  return cells;
}


function overlaps(a, b) {
  const cellsB = new Set(cellsOf(b));

  return cellsOf(a).some(c => cellsB.has(c));
}


// Troba la primera cel·la lliure (d'esquerra a dreta,
// de dalt a baix) on hi càpiga un gadget colSpan x rowSpan
// sense sortir de la graella ni xocar amb cap altre gadget.

function findFreeCell(existingGadgets, colSpan, rowSpan) {
  const span = Math.min(colSpan, GRID_COLUMNS);

  for (let row = 0; ; row++) {
    for (let col = 0; col <= GRID_COLUMNS - span; col++) {

      const candidate = { col, row, colSpan: span, rowSpan };

      const collides = existingGadgets.some(
        g => overlaps(candidate, g)
      );

      if (!collides) {
        return { col, row };
      }
    }
  }
}


// ─────────────────────────────────────────────
// GADGETS
// ─────────────────────────────────────────────

export function getGadgets(
  boatId
) {
  return getBoat(boatId)
    ?.gadgets || null;
}


export function setGadgets(
  boatId,
  gadgets
) {
  const db = load();

  const boat =
    db.boats.find(
      b => b.id === boatId
    );

  if (!boat) {
    return null;
  }

  boat.gadgets = gadgets;

  save(db);

  return boat.gadgets;
}


// ─────────────────────────────────────────────
// ADD GADGET
// ─────────────────────────────────────────────

export function addGadget(
  boatId,
  gadget
) {
  const db = load();

  const boat =
    db.boats.find(
      b => b.id === boatId
    );

  if (!boat) {
    return null;
  }

  const colSpan = gadget.colSpan || 1;
  const rowSpan = gadget.rowSpan || 1;

  const hasPosition =
    Number.isInteger(gadget.col) &&
    Number.isInteger(gadget.row);

  const { col, row } = hasPosition
    ? { col: gadget.col, row: gadget.row }
    : findFreeCell(boat.gadgets, colSpan, rowSpan);

  const newGadget = {
    id:
      gadget.id ||
      `gadget-${Date.now()}`,

    type:
      gadget.type || 'gauge',

    title:
      gadget.title || 'INSTRUMENT',

    source:
      gadget.source || 'tuya',

    device_id:
      gadget.device_id,

    code:
      gadget.code,

    unit:
      gadget.unit || '',

    // "simple" (targeta petita) o "detailed" (targeta gran amb
    // valor+gràfica+alarmes+interruptor, integrada al panell).
    displayMode:
      gadget.displayMode || 'simple',

    enabled:
      gadget.enabled !== false,

    col,
    row,
    colSpan,
    rowSpan
  };

  boat.gadgets.push(newGadget);

  save(db);

  return newGadget;
}


// ─────────────────────────────────────────────
// UPDATE GADGET
// ─────────────────────────────────────────────

export function updateGadget(
  boatId,
  gadgetId,
  changes
) {
  const db = load();

  const boat =
    db.boats.find(
      b => b.id === boatId
    );

  if (!boat) {
    return null;
  }

  const gadget =
    boat.gadgets.find(
      g => g.id === gadgetId
    );

  if (!gadget) {
    return null;
  }

  Object.assign(
    gadget,
    changes
  );

  save(db);

  return gadget;
}


// ─────────────────────────────────────────────
// DELETE GADGET
// ─────────────────────────────────────────────

export function deleteGadget(
  boatId,
  gadgetId
) {
  const db = load();

  const boat =
    db.boats.find(
      b => b.id === boatId
    );

  if (!boat) {
    return null;
  }

  const index =
    boat.gadgets.findIndex(
      g => g.id === gadgetId
    );

  if (index === -1) {
    return null;
  }

  const removed =
    boat.gadgets.splice(
      index,
      1
    )[0];

  save(db);

  return removed;
}


// ─────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────
//
// Un usuari 'admin' no té boatId (veu tots els vaixells).
// Un usuari 'client' té un boatId i només pot operar sobre
// aquell vaixell. La contrasenya es guarda com a hash
// (bcrypt), mai en clar; el hashing viu a auth.js.
//

export function getUserByUsername(username) {
  return load().users.find(
    u => u.username === username
  );
}


export function getUserById(id) {
  return load().users.find(
    u => u.id === id
  );
}


export function listUsers() {
  return load().users.map(
    ({ passwordHash, ...user }) => user
  );
}


export function addUser({ id, username, passwordHash, role, boatId }) {
  const db = load();

  if (db.users.some(u => u.username === username)) {
    throw new Error(
      'Ja existeix un usuari amb aquest nom'
    );
  }

  if (role !== 'admin' && role !== 'client') {
    throw new Error(
      "El rol ha de ser 'admin' o 'client'"
    );
  }

  if (role === 'client' && !boatId) {
    throw new Error(
      "Un usuari 'client' ha de tenir 'boatId'"
    );
  }

  const user = {
    id: id || `user-${Date.now()}`,
    username,
    passwordHash,
    role,
    boatId: role === 'client' ? boatId : null,
  };

  db.users.push(user);

  save(db);

  return user;
}


export function setUserPassword(username, passwordHash) {
  const db = load();

  const user = db.users.find(
    u => u.username === username
  );

  if (!user) {
    return null;
  }

  user.passwordHash = passwordHash;

  save(db);

  return { ok: true };
}


export function updateUserPassword(userId, newPasswordHash) {
  const db = load();

  const user = db.users.find(
    u => u.id === userId
  );

  if (!user) {
    return null;
  }

  user.passwordHash = newPasswordHash;

  save(db);

  return { id: user.id, username: user.username };
}


export function updateUserRole(username, role) {
  const db = load();

  if (role !== 'admin' && role !== 'client') {
    throw new Error(
      "El rol ha de ser 'admin' o 'client'"
    );
  }

  const user = db.users.find(
    u => u.username === username
  );

  if (!user) {
    return null;
  }

  user.role = role;

  save(db);

  return { id: user.id, username: user.username, role: user.role, boatId: user.boatId };
}


export function deleteUserByUsername(username) {
  const db = load();

  const index = db.users.findIndex(
    u => u.username === username
  );

  if (index === -1) {
    return null;
  }

  const removed = db.users.splice(index, 1)[0];

  save(db);

  return { id: removed.id, username: removed.username };
}


// ─────────────────────────────────────────────
// VERSIÓ DE L'APP (per avisar els clients d'actualitzacions)
// ─────────────────────────────────────────────
//
// Com que l'app es distribueix com a APK directe (fora de la Play
// Store), no hi ha actualització automàtica. Guardem aquí quina és
// l'última versió publicada perquè la pròpia app ho pugui comprovar
// sola en obrir-se i avisar l'usuari si en surt una de més nova.

export function getAppVersionInfo() {
  const db = load();
  return db.appVersion || null;
}

export function setAppVersionInfo({ versionCode, versionName, downloadUrl, releaseNotes }) {
  const db = load();

  db.appVersion = {
    versionCode,
    versionName,
    downloadUrl,
    releaseNotes: releaseNotes || '',
  };

  save(db);

  return db.appVersion;
}