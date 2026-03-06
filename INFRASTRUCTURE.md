# Infraestructura — AI Command Bridge

## Arquitectura general

```
[Browser / Móvil]
       │
       ▼
[VPS Ionos — Ubuntu]          [Mac Local]
  Nginx :80/:443               Node.js :3000
  Docker: panel :8080    ◄──── Cloudflare Tunnel
  (HTML estático)              backend_mac/server.js
```

---

## Servicios en el VPS

| Contenedor | Puerto interno | Puerto externo | Descripción |
|---|---|---|---|
| `ai-command-bridge-panel` | 80 | 8080 | Panel HTML estático (Nginx) |
| `iamet-website` | 3000 | 3001 | iamet.mx |
| `iamet-cableado` | 3000 | 3003 | cableado.iamet.mx |
| `crm-iamet-web-1` | 8000 | 8007 | crm.iamet.mx |
| `gesti-n-de-ventas-web-1` | 8000 | 8000 | nethive.mx |
| `gesti-n-de-ventas-db-1` | 3306 | 3306 | MySQL |

## Nginx (sistema host)

| Config | Dominio | Proxy a |
|---|---|---|
| `iamet.mx` | iamet.mx, www.iamet.mx | :3001 |
| `cableado.iamet.mx.conf` | cableado.iamet.mx | :3003 |
| `crm.iamet.mx` | crm.iamet.mx | :8007 |
| `nethive` | nethive.mx, www.nethive.mx, IP | :8000 |
| `bridge` *(auto-generado)* | subdominio asignado | :8080 |

---

## Motor Mac (backend_mac/)

| Archivo | Descripción |
|---|---|
| `server.js` | Servidor Node.js + Socket.io con autenticación PIN |
| `package.json` | Dependencias: express, socket.io, cors |

**Arrancar el motor:**
```bash
cd backend_mac
node server.js
# Puerto: 3000
```

**Exponer con Cloudflare Tunnel:**
```bash
npx cloudflared tunnel --url http://localhost:3000
# Copiar la URL generada y actualizar MAC_HUB_URL en public/index.html
```

---

## Panel VPS (frontend_vps/)

| Archivo | Descripción |
|---|---|
| `Dockerfile` | nginx:alpine + copia public/ |
| `docker-compose.yml` | Servicio `panel` en puerto 8080 |
| `nginx/default.conf` | Sirve archivos estáticos |
| `public/index.html` | UI del chat + lógica Socket.io |

---

## CI/CD — GitHub Actions

**Archivo:** `.github/workflows/deploy.yml`

### Triggers
- **Push a `main`** → deploy automático (sin dominio)
- **Manual** (Actions → Run workflow) → deploy + dominio + SSL opcional

### Secrets requeridos en GitHub

| Secret | Descripción |
|---|---|
| `VPS_HOST` | IP del servidor Ionos |
| `VPS_USER` | Usuario SSH |
| `VPS_SSH_KEY` | Clave privada SSH completa |
| `VPS_PORT` | Puerto SSH (normalmente 22) |
| `BRIDGE_DOMAIN` | *(opcional)* Subdominio permanente asignado |
| `CERTBOT_EMAIL` | *(opcional)* Email para certificados SSL |

### Flujo del deploy

```
Push a main
    │
    ├─ git pull en VPS
    ├─ docker compose down
    ├─ docker compose up --build
    │
    └─ ¿BRIDGE_DOMAIN configurado?
         ├─ SÍ → genera nginx.conf + certbot SSL
         └─ NO → panel accesible en :8080 (solo red interna)
```

---

## Cómo asignar dominio a un deploy

### Opción A — Via GitHub Actions (recomendado)
1. En Newbox/DNS: crear registro `A` → `bridge.iamet.mx` → IP del VPS
2. En GitHub: `Actions` → `Deploy to VPS` → `Run workflow`
3. Ingresar el subdominio en el input: `bridge.iamet.mx`
4. El workflow crea la config Nginx + genera el certificado SSL automáticamente

### Opción B — Secret permanente
1. En GitHub: `Settings` → `Secrets` → agregar `BRIDGE_DOMAIN=bridge.iamet.mx`
2. El próximo push configura Nginx + SSL automáticamente

### Opción C — Manual en el VPS
```bash
sudo nano /etc/nginx/sites-available/bridge
# Pegar config con server_name y proxy_pass a :8080
sudo ln -s /etc/nginx/sites-available/bridge /etc/nginx/sites-enabled/bridge
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d bridge.iamet.mx
```

---

## Seguridad

- **PIN de acceso** obligatorio en el frontend (`MASTER_PIN` en `backend_mac/server.js`)
- PIN actual: `1234` → cambiar antes de producción
- Recomendado: mover PIN a variable de entorno `.env` con `dotenv`
- Autenticación via `socket.handshake.auth.token` (Socket.io middleware)
- `sessionStorage` guarda el token — se borra al cerrar la pestaña

---

## Pendientes antes de producción

- [ ] Mover `MASTER_PIN` a `.env` con `dotenv`
- [ ] Crear registro DNS para subdominio definitivo
- [ ] Asignar dominio via GitHub Actions workflow_dispatch
- [ ] Cambiar `MAC_HUB_URL` en `public/index.html` cuando cambie el túnel Cloudflare
- [ ] Implementar lógica real de IA (reemplazar `exec()` con llamadas a APIs)
