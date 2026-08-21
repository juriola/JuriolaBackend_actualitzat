import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import {
  addBoat,
  getBoat,
  getDevice,
  getDevices,
  getOrCreateDeviceByTuyaId,
  addRtspDevice,
  getGadgets,
  getLocalInstruments,
  getBoatTuyaUid,
  setBoatTuyaUid,
  listBoats,
  setGadgets,
  addGadget,
  updateGadget,
  deleteGadget,
  initDb,
  getUserByUsername,
  getUserById,
  updateUserPassword,
  getAppVersionInfo,
  setAppVersionInfo,
  GRID_COLUMNS,
  configureVictronDevice,
  getVictronDeviceConfig,
  updateVictronReading,
  waitForPersist,
  getVictronDeviceStatusItems,
  getVictronInstruments,
  configureAninerelDevice,
  getAninerelDeviceConfig,
  updateAninerelReading,
  getAninerelDeviceStatusItems,
  getAninerelInstruments,
  configureRenogyDevice,
  getRenogyDeviceConfig,
  updateRenogyReading,
  getRenogyDeviceStatusItems,
  getRenogyInstruments
} from './store.js';

import {
  getAvailableInstruments,
  getDeviceHistory,
  getDeviceStatus,
  getLiveStreamUrl,
  sendCommand
} from './tuyaAdapter.js';

import { parseVictronAdvertisement } from './victronDecoder.js';
import { parseAninerelResponse } from './aninerelDecoder.js';
import { parseRenogyResponse } from './renogyDecoder.js';

import {
  verifyPassword,
  hashPassword,
  signToken,
  requireAuth,
  requireBoatAccess,
  requireAdmin
} from './auth.js';

const app = express();

app.use(cors());
app.use(express.json());


// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'Juriola Backend',
    version: '1.0.0',
    gridColumns: GRID_COLUMNS
  });
});


// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: "Cal indicar 'username' i 'password'"
    });
  }

  const user = getUserByUsername(username);

  if (!user) {
    return res.status(401).json({
      error: 'Credencials incorrectes'
    });
  }

  const valid = await verifyPassword(
    password,
    user.passwordHash
  );

  if (!valid) {
    return res.status(401).json({
      error: 'Credencials incorrectes'
    });
  }

  const token = signToken(user);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      boatId: user.boatId,
    }
  });
});


app.get('/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});


// ─────────────────────────────────────────────
// VERSIÓ DE L'APP
// ─────────────────────────────────────────────
//
// GET és pública (sense login): l'app la consulta just en obrir-se,
// abans fins i tot de tenir sessió iniciada en alguns casos.

app.get('/app/version', (_req, res) => {
  const info = getAppVersionInfo();
  res.json(info || {});
});

app.put('/app/version', requireAuth, requireAdmin, (req, res) => {
  const { versionCode, versionName, downloadUrl, releaseNotes } = req.body || {};

  if (!versionCode || !versionName || !downloadUrl) {
    return res.status(400).json({
      error: "Calen 'versionCode', 'versionName' i 'downloadUrl'"
    });
  }

  const info = setAppVersionInfo({ versionCode, versionName, downloadUrl, releaseNotes });

  res.json(info);
});


app.put('/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: "Cal indicar 'currentPassword' i 'newPassword'"
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      error: 'La contrasenya nova ha de tenir com a mínim 6 caràcters'
    });
  }

  const user = getUserById(req.user.sub);

  if (!user) {
    return res.status(404).json({
      error: 'Usuari no trobat'
    });
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);

  if (!valid) {
    return res.status(401).json({
      error: 'La contrasenya actual no és correcta'
    });
  }

  const newPasswordHash = await hashPassword(newPassword);

  updateUserPassword(user.id, newPasswordHash);

  res.json({ ok: true });
});


// ─────────────────────────────────────────────
// BOATS
// ─────────────────────────────────────────────
//
// Totes les rutes amb :boatId van protegides amb requireAuth +
// requireBoatAccess (un 'client' només veu el seu propi vaixell;
// un 'admin' els veu tots).
//

app.get('/boats', requireAuth, requireAdmin, (_req, res) => {
  res.json(listBoats());
});


app.get('/boats/:boatId', requireAuth, requireBoatAccess, (req, res) => {
  const boat = getBoat(req.params.boatId);

  if (!boat) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  res.json({
    id: boat.id,
    name: boat.name
  });
});


app.post('/boats', requireAuth, requireAdmin, (req, res) => {
  try {
    const boat = addBoat(req.body);

    res.status(201).json(boat);
  } catch (e) {
    res.status(400).json({
      error: e.message
    });
  }
});


// ─────────────────────────────────────────────
// INSTRUMENTS DISPONIBLES
// ─────────────────────────────────────────────
//
// Aquesta és la llista que utilitzarà:
//
// "AFEGIR INSTRUMENT"
//
// Ara surt dels dispositius coneguts del vaixell.
// Més endavant hi afegirem NMEA.
//

app.get('/boats/:boatId/instruments', requireAuth, requireBoatAccess, async (req, res) => {
  const boat = getBoat(req.params.boatId);

  if (!boat) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  try {
    // Font principal: el compte Tuya real d'aquest client,
    // amb TOT el que hi hagi donat d'alta (no cal registrar
    // res a mà a la nostra base de dades).
    const tuyaInstruments = await getAvailableInstruments(boat);
    const victronInstruments = getVictronInstruments(boat.id);
    const aninerelInstruments = getAninerelInstruments(boat.id);
    const renogyInstruments = getRenogyInstruments(boat.id);

    return res.json([...tuyaInstruments, ...victronInstruments, ...aninerelInstruments, ...renogyInstruments]);

  } catch (e) {
    console.error(e);

    // Si encara no hi ha credencials Tuya configurades pel
    // vaixell (o falla la crida), fem servir el catàleg local
    // com a fallback perquè el client no es quedi sense res
    // (ja inclou tant Tuya local com Victron/Aninerel).
    const fallback = getLocalInstruments(boat.id) || [];

    res.json(fallback);
  }
});


// ─────────────────────────────────────────────
// UID TUYA DEL VAIXELL
// ─────────────────────────────────────────────
//
// Aquí es guarda el UID que Tuya assigna en vincular
// el compte d'app del client al nostre projecte
// (Devices > Link Tuya App Account, dins iot.tuya.com).
//

app.get('/boats/:boatId/tuya-uid', requireAuth, requireBoatAccess, (req, res) => {
  const boat = getBoat(req.params.boatId);

  if (!boat) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  res.json({
    uid: getBoatTuyaUid(req.params.boatId)
  });
});


app.put('/boats/:boatId/tuya-uid', requireAuth, requireBoatAccess, (req, res) => {
  const { uid } = req.body;

  if (!uid) {
    return res.status(400).json({
      error: "Cal indicar 'uid'"
    });
  }

  const tuya = setBoatTuyaUid(
    req.params.boatId,
    uid
  );

  if (!tuya) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  res.json(tuya);
});


// ─────────────────────────────────────────────
// DEVICES
// ─────────────────────────────────────────────

app.get('/boats/:boatId/devices', requireAuth, requireBoatAccess, (req, res) => {
  const devices = getDevices(
    req.params.boatId
  );

  if (!devices) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  res.json(devices);
});


// Registra (o reutilitza, si ja existeix) un device local a partir
// d'un instrument Tuya trobat via GET .../instruments. Cal fer-ho
// abans de crear-hi un gadget a sobre.
//
// Exemple:
// POST /boats/juriola/devices
// { "tuya_device_id": "bfc0ff8e...", "name": "Sensor Tª Nevera" }

app.post('/boats/:boatId/devices', requireAuth, requireBoatAccess, (req, res) => {
  const { tuya_device_id, name, params } = req.body || {};

  if (!tuya_device_id) {
    return res.status(400).json({
      error: "Cal indicar 'tuya_device_id'"
    });
  }

  const device = getOrCreateDeviceByTuyaId(
    req.params.boatId,
    { tuyaDeviceId: tuya_device_id, name, params }
  );

  if (!device) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  res.status(201).json(device);
});


// ─────────────────────────────────────────────
// CÀMERA RTSP (no-Tuya): crea dispositiu + gadget
// de tipus "camera" en un sol pas.
// ─────────────────────────────────────────────

app.post('/boats/:boatId/devices/rtsp-camera', requireAuth, requireBoatAccess, (req, res) => {
  const { name, rtsp_url } = req.body || {};

  if (!rtsp_url) {
    return res.status(400).json({
      error: "Cal indicar 'rtsp_url'"
    });
  }

  const device = addRtspDevice(
    req.params.boatId,
    { name, rtspUrl: rtsp_url }
  );

  if (!device) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  const gadget = addGadget(
    req.params.boatId,
    {
      type: 'camera',
      title: device.name,
      source: 'rtsp',
      device_id: device.id,
      code: '',
      unit: '',
    }
  );

  res.status(201).json({ device, gadget });
});


app.get(
  '/boats/:boatId/devices/:deviceId/status',
  requireAuth, requireBoatAccess,
  async (req, res) => {
    try {
      const device = getDevice(
        req.params.boatId,
        req.params.deviceId
      );

      if (!device) {
        return res.status(404).json({
          error: 'Dispositiu no trobat'
        });
      }

      // Victron/Aninerel: no hi ha cap API a consultar — l'última
      // lectura ja queda desada localment cada cop que l'ESP32
      // corresponent n'envia una de nova.
      if (device.source === 'victron') {
        return res.json(getVictronDeviceStatusItems(device));
      }

      if (device.source === 'aninerel') {
        return res.json(getAninerelDeviceStatusItems(device));
      }

      if (device.source === 'renogy') {
        return res.json(getRenogyDeviceStatusItems(device));
      }

      res.json(
        await getDeviceStatus(
          device.tuya_device_id
        )
      );

    } catch (e) {
      console.error(e);

      res.status(502).json({
        error: e.message
      });
    }
  }
);


app.post(
  '/boats/:boatId/devices/:deviceId/command',
  requireAuth, requireBoatAccess,
  async (req, res) => {
    try {
      const device = getDevice(
        req.params.boatId,
        req.params.deviceId
      );

      if (!device) {
        return res.status(404).json({
          error: 'Dispositiu no trobat'
        });
      }

      const { code, value } = req.body;

      if (!code) {
        return res.status(400).json({
          error: "Cal indicar 'code'"
        });
      }

      res.json(
        await sendCommand(
          device.tuya_device_id,
          code,
          value
        )
      );

    } catch (e) {
      console.error(e);

      res.status(502).json({
        error: e.message
      });
    }
  }
);


app.get(
  '/boats/:boatId/devices/:deviceId/history',
  requireAuth, requireBoatAccess,
  async (req, res) => {
    try {
      const device = getDevice(
        req.params.boatId,
        req.params.deviceId
      );

      if (!device) {
        return res.status(404).json({
          error: 'Dispositiu no trobat'
        });
      }

      const code = req.query.code;

      if (!code) {
        return res.status(400).json({
          error: "Cal indicar '?code='"
        });
      }

      const hours = Math.min(
        Math.max(
          Number(req.query.hours || 6),
          1
        ),
        720 // 30 dies
      );

      const end = Date.now();

      const history = await getDeviceHistory(
        device.tuya_device_id,
        code,
        end - hours * 3600000,
        end
      );

      res.json(history);

    } catch (e) {
      console.error(e);

      res.status(502).json({
        error: e.message
      });
    }
  }
);


// ─────────────────────────────────────────────
// CÀMERA: URL DE STREAMING EN DIRECTE
// ─────────────────────────────────────────────
//
// Retorna una URL HLS temporal (caduca al cap d'uns minuts): cal
// demanar-ne una de nova cada cop que s'obre la pantalla de la càmera.
//

app.get(
  '/boats/:boatId/devices/:deviceId/stream',
  requireAuth, requireBoatAccess,
  async (req, res) => {
    try {
      const device = getDevice(
        req.params.boatId,
        req.params.deviceId
      );

      if (!device) {
        return res.status(404).json({
          error: 'Dispositiu no trobat'
        });
      }

      // Càmera RTSP pròpia (no-Tuya): la URL ja la tenim desada, no cal
      // demanar res a cap API externa.
      if (device.source === 'rtsp') {
        const rtspUrl = device.params?.url;

        if (!rtspUrl) {
          return res.status(502).json({
            error: 'Aquest dispositiu no té cap URL RTSP configurada'
          });
        }

        return res.json({ url: rtspUrl });
      }

      const type = req.query.type || 'hls';

      const url = await getLiveStreamUrl(
        device.tuya_device_id,
        type
      );

      if (!url) {
        return res.status(502).json({
          error: 'Tuya no ha retornat cap URL de streaming'
        });
      }

      res.json({ url });

    } catch (e) {
      console.error(e);

      res.status(502).json({
        error: e.message
      });
    }
  }
);


// ─────────────────────────────────────────────
// VICTRON
// ─────────────────────────────────────────────
//
// L'ESP32 gateway del vaixell NO va autenticat amb JWT (no és un
// usuari): es protegeix amb una clau senzilla per header, si es
// configura VICTRON_GATEWAY_KEY a l'entorn.
//

app.post('/boats/:boatId/victron/data', async (req, res) => {
  const gatewayKey = process.env.VICTRON_GATEWAY_KEY;

  if (gatewayKey && req.header('x-device-key') !== gatewayKey) {
    return res.status(401).json({
      error: 'Clau de dispositiu invàlida'
    });
  }

  const { mac, rawData } = req.body || {};

  if (!mac || !rawData) {
    return res.status(400).json({
      error: "Cal indicar 'mac' i 'rawData'"
    });
  }

  const config = getVictronDeviceConfig(
    req.params.boatId,
    mac
  );

  if (!config) {
    return res.status(404).json({
      error: `Cap dispositiu Victron configurat amb MAC ${mac} per aquest vaixell`
    });
  }

  try {
    const parsed = parseVictronAdvertisement(
      rawData,
      config.encryptionKey
    );

    const status = {
      kind: parsed.kind,
      deviceState: parsed.deviceState,
      chargerErrorCode: parsed.chargerErrorCode,
      batteryVoltage: parsed.batteryVoltage,
      batteryCurrent: parsed.batteryCurrent,
      yieldToday: parsed.yieldToday,
      solarPower: parsed.solarPower,
      loadCurrent: parsed.loadCurrent,
    };

    const device = updateVictronReading(
      req.params.boatId,
      mac,
      status
    );

    res.json({ ok: true, device: device.id, status });

  } catch (e) {
    console.error(e);

    res.status(400).json({
      error: e.message
    });
  }
});


// Ruta d'administració: dona d'alta la MAC + clau de desxifratge d'un
// dispositiu Victron, un cop tretes de VictronConnect (Settings >
// Product info > Instant readout via Bluetooth > Show).
//
// Exemple:
// PUT /boats/juriola/victron-config
// { "mac": "A2:60:11:30:03:80", "encryptionKey": "32caractershex...", "name": "SmartSolar" }

app.put('/boats/:boatId/victron-config', requireAuth, requireBoatAccess, async (req, res) => {
  const { mac, encryptionKey, name } = req.body || {};

  if (!mac || !encryptionKey) {
    return res.status(400).json({
      error: "Cal indicar 'mac' i 'encryptionKey'"
    });
  }

  const config = configureVictronDevice(
    req.params.boatId,
    { mac, encryptionKey, name }
  );

  if (!config) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  // Esperem que l'escriptura a Upstash hagi acabat de veritat abans de
  // confirmar "ok:true". Sense això, si el contenidor de Render es
  // reciclava just després de respondre, la configuració es perdia
  // silenciosament i el proper avís del gateway ESP32 tornava a donar
  // 404 "Cap dispositiu Victron configurat", tot i haver rebut "ok:true".
  try {
    await waitForPersist();
  } catch (e) {
    console.error('[victron-config] No s\'ha pogut desar de forma persistent:', e);

    return res.status(502).json({
      error: 'La configuració s\'ha aplicat en memòria però no s\'ha pogut desar de forma persistent (torna-ho a provar en uns segons)'
    });
  }

  res.json({ ok: true, config });
});


// ─────────────────────────────────────────────
// RUTA DE DIAGNÒSTIC TEMPORAL (per la depuració del gateway Victron
// d'avui). Es pot eliminar un cop confirmat que tot funciona bé.
// Mostra directament què hi ha desat, sense haver d'interpretar codis
// d'error indirectes.
// ─────────────────────────────────────────────
app.get('/boats/:boatId/victron-config/debug', requireAuth, requireBoatAccess, (req, res) => {
  const boat = getBoat(req.params.boatId);

  if (!boat) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  res.json({
    boatId: boat.id,
    victronDevices: boat.victronDevices || [],
  });
});


// ─────────────────────────────────────────────
// ANINEREL / LANMAO BMS
// ─────────────────────────────────────────────
//
// Mateix esperit que Victron: l'ESP32 gateway (placa separada, connexió
// GATT activa) no va autenticat amb JWT — es protegeix amb la mateixa
// clau senzilla per header (es pot reutilitzar VICTRON_GATEWAY_KEY o
// definir-ne una de pròpia amb ANINEREL_GATEWAY_KEY si es prefereix
// separar-les).
//

app.post('/boats/:boatId/aninerel/data', async (req, res) => {
  const gatewayKey = process.env.ANINEREL_GATEWAY_KEY || process.env.VICTRON_GATEWAY_KEY;

  if (gatewayKey && req.header('x-device-key') !== gatewayKey) {
    return res.status(401).json({
      error: 'Clau de dispositiu invàlida'
    });
  }

  const { mac, rawData } = req.body || {};

  if (!mac || !rawData) {
    return res.status(400).json({
      error: "Cal indicar 'mac' i 'rawData'"
    });
  }

  const config = getAninerelDeviceConfig(
    req.params.boatId,
    mac
  );

  if (!config) {
    return res.status(404).json({
      error: `Cap BMS Aninerel configurat amb MAC ${mac} per aquest vaixell`
    });
  }

  try {
    const status = parseAninerelResponse(rawData);

    const device = updateAninerelReading(
      req.params.boatId,
      mac,
      status
    );

    res.json({ ok: true, device: device.id, status });

  } catch (e) {
    console.error(e);

    res.status(400).json({
      error: e.message
    });
  }
});


// Ruta d'administració: dona d'alta la MAC d'un BMS Aninerel (una per
// bateria: Babord, Estribord...). A diferència de Victron, aquest BMS
// no necessita cap clau de desxifratge (la connexió GATT no va xifrada).
//
// Exemple:
// PUT /boats/juriola/aninerel-config
// { "mac": "A2:60:11:30:09:69", "name": "Babord" }

app.put('/boats/:boatId/aninerel-config', requireAuth, requireBoatAccess, async (req, res) => {
  const { mac, name } = req.body || {};

  if (!mac) {
    return res.status(400).json({
      error: "Cal indicar 'mac'"
    });
  }

  const config = configureAninerelDevice(
    req.params.boatId,
    { mac, name }
  );

  if (!config) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  // Mateix motiu que a victron-config: confirmar "ok:true" només un cop
  // l'escriptura a Upstash ha acabat de veritat.
  try {
    await waitForPersist();
  } catch (e) {
    console.error('[aninerel-config] No s\'ha pogut desar de forma persistent:', e);

    return res.status(502).json({
      error: 'La configuració s\'ha aplicat en memòria però no s\'ha pogut desar de forma persistent (torna-ho a provar en uns segons)'
    });
  }

  res.json({ ok: true, config });
});


// ─────────────────────────────────────────────
// RENOGY DC-DC
// ─────────────────────────────────────────────
//
// Mateix esperit que Aninerel: connexió GATT activa des de l'ESP32
// gateway, protegida amb la mateixa clau senzilla per header. A
// diferència de l'Aninerel, aquí el protocol és Modbus RTU estàndard
// (documentat públicament), així que la comanda de lectura es pot
// reconstruir/validar amb renogyDecoder.js sense dependre de bytes
// capturats fixos.
//

app.post('/boats/:boatId/renogy/data', async (req, res) => {
  const gatewayKey = process.env.RENOGY_GATEWAY_KEY || process.env.ANINEREL_GATEWAY_KEY || process.env.VICTRON_GATEWAY_KEY;

  if (gatewayKey && req.header('x-device-key') !== gatewayKey) {
    return res.status(401).json({
      error: 'Clau de dispositiu invàlida'
    });
  }

  const { mac, rawData } = req.body || {};

  if (!mac || !rawData) {
    return res.status(400).json({
      error: "Cal indicar 'mac' i 'rawData'"
    });
  }

  const config = getRenogyDeviceConfig(
    req.params.boatId,
    mac
  );

  if (!config) {
    return res.status(404).json({
      error: `Cap Renogy configurat amb MAC ${mac} per aquest vaixell`
    });
  }

  try {
    const status = parseRenogyResponse(rawData);

    const device = updateRenogyReading(
      req.params.boatId,
      mac,
      status
    );

    res.json({ ok: true, device: device.id, status });

  } catch (e) {
    console.error(e);

    res.status(400).json({
      error: e.message
    });
  }
});


// Ruta d'administració: dona d'alta la MAC d'un Renogy DC-DC. Igual que
// l'Aninerel, no cal cap clau de xifratge (la connexió GATT no va
// xifrada).
//
// Exemple:
// PUT /boats/juriola/renogy-config
// { "mac": "7C:72:E7:2F:B8:C7", "name": "Renogy DC-DC" }

app.put('/boats/:boatId/renogy-config', requireAuth, requireBoatAccess, async (req, res) => {
  const { mac, name } = req.body || {};

  if (!mac) {
    return res.status(400).json({
      error: "Cal indicar 'mac'"
    });
  }

  const config = configureRenogyDevice(
    req.params.boatId,
    { mac, name }
  );

  if (!config) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  try {
    await waitForPersist();
  } catch (e) {
    console.error('[renogy-config] No s\'ha pogut desar de forma persistent:', e);

    return res.status(502).json({
      error: 'La configuració s\'ha aplicat en memòria però no s\'ha pogut desar de forma persistent (torna-ho a provar en uns segons)'
    });
  }

  res.json({ ok: true, config });
});


// ─────────────────────────────────────────────
// GADGETS
// ─────────────────────────────────────────────

// Obtenir els gadgets del panell

app.get('/boats/:boatId/gadgets', requireAuth, requireBoatAccess, (req, res) => {
  const gadgets = getGadgets(
    req.params.boatId
  );

  if (!gadgets) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  res.json(
    gadgets
      .filter(g => g.enabled)
      .sort(
        (a, b) =>
          (a.row - b.row) ||
          (a.col - b.col)
      )
  );
});


// ─────────────────────────────────────────────
// AFEGIR GADGET
// ─────────────────────────────────────────────
//
// Exemple:
//
// POST /boats/juriola/gadgets
//
// {
//   "type": "gauge",
//   "title": "Temperatura nevera",
//   "device_id": "temp-nevera",
//   "code": "va_temperature",
//   "unit": "°C",
//   "colSpan": 1,
//   "rowSpan": 1
//   // "col"/"row" són opcionals: si no s'indiquen,
//   // s'assigna automàticament la primera cel·la lliure
//   // de la graella.
// }
//

app.post('/boats/:boatId/gadgets', requireAuth, requireBoatAccess, (req, res) => {
  try {
    const gadget = addGadget(
      req.params.boatId,
      req.body
    );

    if (!gadget) {
      return res.status(404).json({
        error: 'Vaixell no trobat'
      });
    }

    res.status(201).json(gadget);

  } catch (e) {
    console.error(e);

    res.status(400).json({
      error: e.message
    });
  }
});


// ─────────────────────────────────────────────
// MODIFICAR GADGET
// ─────────────────────────────────────────────
//
// Principalment servirà per:
// - moure'l
// - canviar mida
// - canviar configuració
//

app.patch(
  '/boats/:boatId/gadgets/:gadgetId',
  requireAuth, requireBoatAccess,
  (req, res) => {

    const gadget = updateGadget(
      req.params.boatId,
      req.params.gadgetId,
      req.body
    );

    if (!gadget) {
      return res.status(404).json({
        error: 'Gadget no trobat'
      });
    }

    res.json(gadget);
  }
);


// ─────────────────────────────────────────────
// ELIMINAR GADGET
// ─────────────────────────────────────────────

app.delete(
  '/boats/:boatId/gadgets/:gadgetId',
  requireAuth, requireBoatAccess,
  (req, res) => {

    const gadget = deleteGadget(
      req.params.boatId,
      req.params.gadgetId
    );

    if (!gadget) {
      return res.status(404).json({
        error: 'Gadget no trobat'
      });
    }

    res.json({
      ok: true,
      deleted: gadget
    });
  }
);


// ─────────────────────────────────────────────
// GUARDAR TOT EL PANELL
// ─────────────────────────────────────────────
//
// Es manté perquè ens pot ser útil per guardar
// diverses modificacions d'una vegada.
//

app.put('/boats/:boatId/gadgets', requireAuth, requireBoatAccess, (req, res) => {

  if (!Array.isArray(req.body.gadgets)) {
    return res.status(400).json({
      error: "El body ha de contenir 'gadgets'"
    });
  }

  const gadgets = setGadgets(
    req.params.boatId,
    req.body.gadgets
  );

  if (!gadgets) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  res.json(gadgets);
});


// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────

app.get('/boats/:boatId/dashboard', requireAuth, requireBoatAccess, (req, res) => {

  const boat = getBoat(
    req.params.boatId
  );

  if (!boat) {
    return res.status(404).json({
      error: 'Vaixell no trobat'
    });
  }

  const gadgets = [
    ...(boat.gadgets || [])
  ]
    .filter(g => g.enabled)
    .sort(
      (a, b) =>
        (a.row - b.row) ||
        (a.col - b.col)
    );

  res.json({
    id: boat.id,
    name: boat.name,
    gadgets
  });
});


// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

const port = Number(
  process.env.PORT || 3000
);

initDb()
  .then(() => {
    app.listen(
      port,
      '0.0.0.0',
      () => {
        console.log(
          `Juriola Backend escoltant a http://0.0.0.0:${port}`
        );
      }
    );
  })
  .catch(err => {
    console.error('No s\'ha pogut inicialitzar la base de dades:', err);
    process.exit(1);
  });
