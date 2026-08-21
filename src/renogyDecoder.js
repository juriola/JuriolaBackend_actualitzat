// ─────────────────────────────────────────────
// RENOGY DC-DC (RBC40D1U-G3) — DESXIFRATGE (BLE GATT actiu, Modbus RTU)
// ─────────────────────────────────────────────
//
// A diferència de l'Aninerel, aquest protocol NO ha calgut revers-
// enginyeritzar-lo des de zero: és Modbus RTU estàndard sobre BLE,
// documentat per la comunitat (projectes renogy-bt / renogy-bt2-reader).
// El CRC és el Modbus CRC16 públic (no una comanda capturada fixa), així
// que aquí SÍ que podem construir i validar la trama nosaltres mateixos.
//
// L'ESP32 gateway (mateix esperit que Victron/Aninerel) no interpreta
// res: envia la comanda de lectura ja construïda i reenvia en cru la
// resposta rebuda; tota la interpretació viu aquí.
//
// ── Trama de COMANDA (gateway -> Renogy) ──
//   FF | 03 | REG_HI REG_LO | COUNT_HI COUNT_LO | CRC16_LO CRC16_HI
//
// ── Trama de RESPOSTA (Renogy -> gateway, per notificació) ──
//   FF | 03 | LEN (1B, en bytes) | DADES (LEN bytes) | CRC16_LO CRC16_HI
//
// Registre de lectura fet servir: 0x0100, 34 registres (0x0022) — el
// mateix bloc que fa servir l'app oficial. Mapa de camps confirmat
// contra captures reals del Juriola (SOC, voltatge, corrent, temp...).
//

export const RENOGY_REG_START = 0x0100;
export const RENOGY_REG_COUNT = 0x0022; // 34 registres

function u16(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

/**
 * CRC16 Modbus estàndard (polinomi 0xA001, inicial 0xFFFF). Igual que la
 * versió en C del firmware — es fa servir aquí per validar la trama
 * rebuda i, si mai cal, per construir noves comandes des del backend.
 */
export function modbusCRC16(data) {
  let crc = 0xffff;

  for (const byte of data) {
    crc ^= byte;

    for (let b = 0; b < 8; b++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }

  return crc;
}

/**
 * Construeix la trama de comanda "Read Holding Registers" (funció
 * Modbus 0x03) per un registre inicial i una quantitat de registres.
 */
export function buildReadRequest(startRegister = RENOGY_REG_START, count = RENOGY_REG_COUNT) {
  const cmd = Buffer.alloc(8);

  cmd[0] = 0xff; // device id (broadcast/estàndard per aquest dongle)
  cmd[1] = 0x03; // funció Modbus: Read Holding Registers
  cmd.writeUInt16BE(startRegister, 2);
  cmd.writeUInt16BE(count, 4);

  const crc = modbusCRC16(cmd.subarray(0, 6));
  cmd.writeUInt8(crc & 0xff, 6);        // CRC en little-endian (byte baix primer)
  cmd.writeUInt8((crc >> 8) & 0xff, 7);

  return cmd;
}

/**
 * Decodifica la resposta completa (capçalera FF 03 inclosa) del bloc de
 * registres 0x0100.
 *
 * @param {Buffer|string} rawResponse - Bytes complets (o hex string) de
 *   la notificació rebuda pel gateway ESP32.
 */
export function parseRenogyResponse(rawResponse) {
  const raw = Buffer.isBuffer(rawResponse)
    ? rawResponse
    : Buffer.from(rawResponse, 'hex');

  if (raw.length < 5 || raw[0] !== 0xff || raw[1] !== 0x03) {
    throw new Error("Trama Renogy no vàlida (falta capçalera FF 03)");
  }

  const dataLen = raw[2];
  const payload = raw.subarray(3, 3 + dataLen);
  const receivedCrc = raw.readUInt16LE(3 + dataLen);

  const calculatedCrc = modbusCRC16(raw.subarray(0, 3 + dataLen));

  if (receivedCrc !== calculatedCrc) {
    throw new Error(
      `CRC Renogy invàlid (rebut ${receivedCrc.toString(16)}, calculat ${calculatedCrc.toString(16)}) — trama corrupta`
    );
  }

  if (payload.length < 0x1e) {
    throw new Error(`Payload Renogy massa curt (${payload.length} bytes)`);
  }

  const tempWord = u16(payload, 0x06); // offset del registre 0x103 dins el payload (byte 6)

  return {
    kind: 'renogy_dcdc',

    soc: u16(payload, 0x00),                    // % — confirmat exacte contra pantalla
    packVoltage: u16(payload, 0x02) / 10,        // V — confirmat exacte (12.7V)
    chargingCurrent: u16(payload, 0x04) / 100,   // A — confirmat exacte (0.00A)

    controllerTemp: (tempWord >> 8) & 0xff,      // °C — plausible (28°C)
    batteryTemp: tempWord & 0xff,                // °C — plausible (25°C)

    loadVoltage: u16(payload, 0x08) / 10,        // V
    loadCurrent: u16(payload, 0x0a) / 100,       // A
    loadPower: u16(payload, 0x0c),               // W

    pvVoltage: u16(payload, 0x0e) / 10,          // V
    pvCurrent: u16(payload, 0x10) / 100,         // A
    chargingPower: u16(payload, 0x12),           // W — confirmat exacte (0W, coincideix amb l'app)

    todayMinVoltage: u16(payload, 0x16) / 10,    // V
    todayMaxVoltage: u16(payload, 0x18) / 10,    // V
  };
}
