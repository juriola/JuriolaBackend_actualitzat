# Juriola Backend

Backend multi-vaixell per a JURIOLA. La capa d'API de l'app no depèn de Tuya: els dispositius s'emmagatzemen com a fonts de dades i els gadgets del panell són configuració independent.

## Primera prova: Juriola

Gadgets configurats:
- temperatura de la nevera
- històric de temperatura de la nevera
- humitat
- interruptor de la nevera

Dispositius Tuya inicials:
- Sensor Tª Nevera: `bfc0ff8e4c2b8413add3tf`
- Interruptor nevera: `bf91907700f896ee46kbr9`

## Posada en marxa

1. Copia `.env.example` a `.env`.
2. Omple `TUYA_CLIENT_ID`, `TUYA_CLIENT_SECRET` i `JWT_SECRET` (genera'l amb `openssl rand -hex 32`).
3. Executa `npm install`.
4. Crea el primer usuari admin:
   `node scripts/create-user.js admin "unaContrasenyaForta" admin`
5. Crea un usuari client per a un vaixell (per exemple, per al vaixell `juriola`):
   `node scripts/create-user.js cavale "unaAltraContrasenya" client juriola`
6. Executa `npm start`.

## Autenticació

Totes les rutes `/boats/:boatId/...` requereixen un token JWT:

```
Authorization: Bearer <token>
```

El token s'obté a `POST /auth/login`. Un usuari amb rol `admin` pot accedir
a qualsevol vaixell; un usuari amb rol `client` només al vaixell (`boatId`)
al qual està vinculat.

- `POST /auth/login` — `{ "username": "...", "password": "..." }` → `{ token, user }`
- `GET /auth/me` — retorna les dades de l'usuari autenticat (a partir del token)

## API principal

- `GET /boats` *(admin)*
- `GET /boats/:boatId`
- `GET /boats/:boatId/devices`
- `GET /boats/:boatId/devices/:deviceId/status`
- `POST /boats/:boatId/devices/:deviceId/command`
- `GET /boats/:boatId/devices/:deviceId/history?code=va_temperature&hours=6`
- `GET /boats/:boatId/gadgets`
- `PUT /boats/:boatId/gadgets`
- `GET /boats/:boatId/dashboard`
