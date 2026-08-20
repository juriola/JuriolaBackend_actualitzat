// ─────────────────────────────────────────────
// ANINEREL / LANMAO BMS — DESXIFRATGE (BLE GATT actiu)
// ─────────────────────────────────────────────
//
// A diferència de Victron (BLE passiu, dades dins l'advertisement), aquest
// BMS ("蓝猫动力" a l'app oficial) no emet res útil per advertising — cal
// connectar-s'hi activament per GATT, escriure una comanda de lectura a la
// característica RX i llegir la resposta per notificació a la característica
// TX. L'ESP32 gateway NO decodifica res: només connecta, envia la comanda i
// reenvia en cru la resposta rebuda; tota la interpretació viu aquí, amb el
// mateix esperit que victronDecoder.js.
//
// Protocol revers-enginyeritzat a partir de captures HCI snoop (btsnoop)
// mentre l'app oficial llegia les bateries Babord i Estribord del Juriola,
// contrastant els bytes amb els valors mostrats a pantalla en cada moment.
//
// ── Trama de COMANDA (app -> BMS) ──
//   A5 A5 | 00 03 | REG (2B, big-endian) | LEN (2B, en PARAULES de 2 bytes) | CRC (2B)
//
// ── Trama de RESPOSTA (BMS -> app, per notificació) ──
//   A5 A5 | 00 03 | LEN (1B, en bytes) | PAYLOAD (LEN bytes) | CRC (2B)
//
// El registre 0x0000 ("dades en temps real") retorna un payload de 144
// bytes amb tot el que necessitem. Encara no s'ha revers-enginyeritzat
// l'algoritme del CRC (no cal per llegir: es reenvia sempre la mateixa
// comanda capturada, ja que l'app oficial sempre demana el mateix).
//

export const ANINEREL_REG_REALTIME = 0x0000;

// Comanda capturada literalment (demana el registre 0x0000, longitud 0x48
// paraules = 144 bytes). L'ESP32 l'envia tal qual, sense recalcular res.
export const ANINEREL_REALTIME_REQUEST_HEX = 'a5a5000300000048442d';

function u16(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

function s16(buf, off) {
  const v = u16(buf, off);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/**
 * Decodifica la resposta completa (tal com arriba per notificació GATT,
 * capçalera A5 A5 inclosa) del registre 0x0000.
 *
 * @param {Buffer|string} rawResponse - Bytes complets (o hex string) de la
 *   notificació rebuda pel gateway ESP32.
 */
export function parseAninerelResponse(rawResponse) {
  const raw = Buffer.isBuffer(rawResponse)
    ? rawResponse
    : Buffer.from(rawResponse, 'hex');

  if (raw.length < 7 || raw[0] !== 0xa5 || raw[1] !== 0xa5) {
    throw new Error("Trama Aninerel no vàlida (falta capçalera A5 A5)");
  }

  const lenByte = raw[4];
  const payload = raw.subarray(5, 5 + lenByte);

  if (payload.length < 0x56) {
    throw new Error(
      `Payload Aninerel massa curt (${payload.length} bytes, s'esperaven almenys 86)`
    );
  }

  const cellCount = u16(payload, 0x26);

  const cellVoltages = [];
  for (let i = 0; i < cellCount && i < 4; i++) {
    cellVoltages.push(u16(payload, 0x28 + i * 2)); // mV
  }

  // 0xFFFF marca "sensor no present" — descartem aquestes lectures.
  const temperatures = [];
  for (const off of [0x52, 0x54]) {
    const raw16 = u16(payload, off);
    if (raw16 !== 0xffff) {
      temperatures.push(Math.round((raw16 / 10 - 273.1) * 10) / 10); // °C
    }
  }

  return {
    kind: 'aninerel_bms',

    // Corrent: enter de 16 bits amb signe. Confirmat contra captures reals:
    // +14.04 A carregant (Estribord), -27..-33 A descarregant (Babord).
    current: s16(payload, 0x02) / 100, // A (+ càrrega / − descàrrega)

    packVoltage: u16(payload, 0x06) / 100, // V — confirmat exacte (13.34V, 13.28V, 13.18V)
    soc: u16(payload, 0x08),               // % — confirmat exacte (99, 60, 91, 89)
    soh: u16(payload, 0x0a),               // % — probable (SOH), no confirmat contra pantalla

    remainingCapacity: u16(payload, 0x0e) / 100, // Ah — probable
    ratedCapacity: u16(payload, 0x12) / 100,     // Ah — confirmat contra pantalla (300.0 Ah)

    cycles: u16(payload, 0x18), // confirmat exacte (2, 3 cicles)

    cellCount,
    cellVoltages, // mV — confirmat exacte contra els 4 valors de pantalla en ambdues bateries

    // Nomenades genèriques: encara no sabem quin sensor físic correspon a
    // cada offset (MOS, cel·la, ambient...). Totes confirmades com a
    // temperatures plausibles (29-31°C) contra els valors de pantalla.
    temperatures, // °C
  };
}
