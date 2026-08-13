import { TuyaClient } from './tuyaClient.js';

// ─────────────────────────────────────────────
// CLIENT TUYA
// ─────────────────────────────────────────────
//
// Un únic projecte Tuya (client_id/secret) compartit
// per tots els vaixells/clients. El que diferencia
// cada client és el seu UID (compte d'app vinculat),
// que es fa servir per filtrar quins dispositius es
// consulten.
//

const client = new TuyaClient({
  clientId: process.env.TUYA_CLIENT_ID,
  clientSecret: process.env.TUYA_CLIENT_SECRET,
  baseUrl: process.env.TUYA_BASE_URL,
});

const SCALE = {
  va_temperature: 0.1,
  temp_current: 0.1,
  minitemp_set: 0.1,
  maxtemp_set: 0.1,
};

const TYPES = {
  switch_1: 'interruptor',
  switch: 'interruptor',

  va_temperature: 'temperatura',
  temp_current: 'temperatura',

  va_humidity: 'humitat',
  humidity_value: 'humitat',

  battery_percentage: 'bateria_percent',
};

const UNITS = {
  va_temperature: '°C',
  temp_current: '°C',
  minitemp_set: '°C',
  maxtemp_set: '°C',

  va_humidity: '%',
  humidity_value: '%',

  battery_percentage: '%',

  switch_1: '',
  switch: '',
};

const scale = (code, value) => {
  return SCALE[code] && typeof value === 'number'
    ? value * SCALE[code]
    : value;
};

const getType = (code) => {
  return TYPES[code] || 'valor';
};

const getUnit = (code) => {
  return UNITS[code] || '';
};


export async function getDeviceInfo(deviceId) {
  return client.get(`/v1.0/devices/${deviceId}`);
}


export async function getDeviceStatus(deviceId) {
  const info = await getDeviceInfo(deviceId);

  return (info?.status || []).map(p => ({
    deviceId,
    source: 'tuya',
    name: info.name,
    online: info.online,
    code: p.code,
    type: getType(p.code),
    value: scale(p.code, p.value),
    unit: getUnit(p.code),
  }));
}


export async function getAvailableInstruments(boat) {

  const uid = boat?.tuya?.uid;

  if (!uid) {
    throw new Error(
      `El vaixell "${boat?.id}" encara no té cap compte Tuya vinculat (falta el UID)`
    );
  }

  // Pas 1: llista bàsica de dispositius d'aquest client (id, nom...).
  // OJO: aquesta crida massiva no sempre retorna el camp "status" ple per
  // a totes les categories de dispositiu, per això NO ens hi refiem per
  // construir els instruments — només la fem servir per saber quins IDs
  // de dispositiu existeixen.
  const result = await client.get(
    `/v1.0/users/${uid}/devices`
  );

  const devices =
    Array.isArray(result) ? result : (result?.devices || []);

  // Pas 2: una crida per dispositiu (la mateixa que ja usa getDeviceStatus),
  // que sí que retorna sempre el "status" complet, sigui quina sigui la
  // categoria del dispositiu.
  const instruments = [];

  for (const device of devices) {
    let info;

    try {
      info = await getDeviceInfo(device.id);
    } catch (e) {
      console.error(`No s'ha pogut llegir el dispositiu ${device.id}:`, e.message);
      continue;
    }

    for (const status of info?.status || []) {

      instruments.push({
        id: `${device.id}:${status.code}`,

        source: 'tuya',

        deviceId: device.id,

        deviceName: info.name || device.name,

        code: status.code,

        type: getType(status.code),

        unit: getUnit(status.code),

        value: scale(
          status.code,
          status.value
        ),

        online: info.online ?? device.online,

        title: `${info.name || device.name} - ${status.code}`,
      });
    }
  }

  return instruments;
}


export async function sendCommand(
  deviceId,
  code,
  value
) {
  return client.post(
    `/v1.0/iot-03/devices/${deviceId}/commands`,
    {
      commands: [
        {
          code,
          value
        }
      ],
    }
  );
}


export async function getDeviceHistory(
  deviceId,
  code,
  startTime,
  endTime
) {

  const path =
    `/v2.0/cloud/thing/${deviceId}/report-logs` +
    `?codes=${encodeURIComponent(code)}` +
    `&start_time=${startTime}` +
    `&end_time=${endTime}` +
    `&size=100`;

  const result = await client.get(path);

  const logs =
    result?.logs ||
    result?.list ||
    [];

  if (logs.length === 0) {
    console.warn(
      `[tuyaAdapter] Cap punt d'històric per a device=${deviceId} code=${code}. ` +
      `Resposta de Tuya: ${JSON.stringify(result)}`
    );
  }

  return logs
    .map(item => ({
      code: item.code,

      value: scale(
        code,
        typeof item.value === 'string'
          ? Number(item.value)
          : item.value
      ),

      time: Number(item.event_time),
    }))
    .filter(x =>
      x.code === code &&
      Number.isFinite(x.time)
    );
}