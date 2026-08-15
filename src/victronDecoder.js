// ─────────────────────────────────────────────
// VICTRON — DESXIFRATGE "INSTANT READOUT" (BLE)
// ─────────────────────────────────────────────
//
// Victron emet per BLE advertising (manufacturer data) un paquet xifrat
// amb AES-128-CTR anomenat "Instant Readout". Aquest mòdul desxifra i
// interpreta aquests paquets. L'ESP32 gateway del vaixell NO desxifra
// res: només reenvia el paquet cru (hex) captat per Bluetooth; tota la
// lògica viu aquí, seguint el mateix esperit que la resta del backend.
//
// Estructura del paquet (manufacturer data complet):
//
//   byte[0]      -> Record type, sempre 0x10 per "Instant Readout"
//   byte[1..2]   -> Model ID (2 bytes, no cal per desxifrar)
//   byte[3]      -> Readout type (sol ser 0xA0)
//   byte[4]      -> Device record type (0x01 = Solar Charger, ...)
//   byte[5..6]   -> Nonce / Data Counter (2 bytes, little-endian)
//   byte[7]      -> Ha de coincidir amb el primer byte de la clau (validació)
//   byte[8..]    -> Dades xifrades (AES-128-CTR)
//

import crypto from 'node:crypto';


export const DEVICE_RECORD_TYPE = {
  SOLAR_CHARGER: 0x01,
  BATTERY_MONITOR: 0x02,
  INVERTER: 0x03,
  DCDC_CONVERTER: 0x04,
  SMART_LITHIUM: 0x05,
  ORION_XS: 0x0f,
};


export const DEVICE_STATE = {
  0: 'Off',
  1: 'Low Power',
  2: 'Fault',
  3: 'Bulk',
  4: 'Absorption',
  5: 'Float',
  6: 'Storage',
  7: 'Equalize (manual)',
  9: 'Inverting',
  11: 'Power Supply',
  245: 'Starting',
  247: 'Auto-Equalize/Absorption',
  252: 'External Control',
};


function decryptPayload(encryptedPayload, nonceBytes, encryptionKey) {
  if (encryptionKey.length !== 16) {
    throw new Error(
      `La clau ha de tenir 16 bytes (32 caràcters hex). Rebut: ${encryptionKey.length} bytes`
    );
  }

  const iv = Buffer.alloc(16, 0);
  nonceBytes.copy(iv, 0);

  const decipher = crypto.createDecipheriv('aes-128-ctr', encryptionKey, iv);
  decipher.setAutoPadding(false);

  return Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);
}


/**
 * Interpreta un paquet complet de manufacturer data de Victron.
 *
 * @param {Buffer|string} rawManufacturerData - Bytes complets (o hex string)
 * @param {string} encryptionKeyHex - Clau de 32 caràcters hex (VictronConnect)
 */
export function parseVictronAdvertisement(rawManufacturerData, encryptionKeyHex) {
  const raw = Buffer.isBuffer(rawManufacturerData)
    ? rawManufacturerData
    : Buffer.from(rawManufacturerData, 'hex');

  if (raw.length < 8) {
    throw new Error('Paquet massa curt per ser un Instant Readout vàlid');
  }

  const recordType = raw[0];

  if (recordType !== 0x10) {
    throw new Error(
      `Record type inesperat: 0x${recordType.toString(16)} (s'esperava 0x10)`
    );
  }

  const modelId = raw.readUInt16LE(1);
  const readoutType = raw[3];
  const deviceRecordType = raw[4];
  const nonceBytes = raw.subarray(5, 7);
  const keyCheckByte = raw[7];
  const encryptedPayload = raw.subarray(8);

  const encryptionKey = Buffer.from(encryptionKeyHex, 'hex');

  if (encryptionKey[0] !== keyCheckByte) {
    throw new Error(
      "La clau de xifratge no coincideix amb aquest paquet (byte de verificació diferent)"
    );
  }

  const decrypted = decryptPayload(encryptedPayload, nonceBytes, encryptionKey);

  const base = { modelId, readoutType, deviceRecordType };

  switch (deviceRecordType) {
    case DEVICE_RECORD_TYPE.SOLAR_CHARGER:
      return { ...base, kind: 'solar_charger', ...parseSolarCharger(decrypted) };

    default:
      return { ...base, kind: 'unknown', rawDecryptedHex: decrypted.toString('hex') };
  }
}


/**
 * Interpreta els 12 bytes desxifrats d'un "Solar Charger" (SmartSolar MPPT).
 */
function parseSolarCharger(data) {
  const deviceStateCode = data.readUInt8(0);
  const chargerErrorCode = data.readUInt8(1);
  const batteryVoltage = data.readInt16LE(2) / 100; // V
  const batteryCurrent = data.readInt16LE(4) / 10; // A
  const yieldToday = (data.readUInt16LE(6) * 10) / 1000; // Wh -> kWh
  const solarPower = data.readUInt16LE(8); // W
  const loadRaw = data.readUInt16LE(10);
  const loadCurrent = (loadRaw & 0x1ff) / 10; // A

  return {
    deviceState: DEVICE_STATE[deviceStateCode] || `Desconegut (${deviceStateCode})`,
    deviceStateCode,
    chargerErrorCode,
    batteryVoltage,
    batteryCurrent,
    yieldToday,
    solarPower,
    loadCurrent,
  };
}
