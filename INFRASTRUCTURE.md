# Infraestructura — VPS Ionos + GitHub Actions

## Arquitectura general

```
[Browser / Móvil]
       │
       ▼
[VPS Ionos — Ubuntu 82.223.44.29]
  Nginx :80/:443  ← único punto de entrada externo
       │
       ├── 82.223.44.29      → :8080  (proyecto en pruebas — rotativo)
       ├── iamet.mx          → :3001
       ├── cableado.iamet.mx → :3003
       ├── crm.iamet.mx      → :8007
       └── nethive.mx        → :8000
```

---

## Regla de oro del VPS

> Ionos **solo expone el puerto 80 y 443** al exterior.
> Todas las apps corren en puertos internos y Nginx las enruta por dominio o IP.
> **Nunca abrir puertos directos** — todo pasa por Nginx.

---

## Flujo de vida de un proyecto

```
1. DESARROLLO
   └── Pruebas locales en el Mac

2. DEPLOY A VPS (sin dominio)
   └── Push a main → GitHub Actions → Docker en puerto interno
   └── Nginx expone el proyecto en http://82.223.44.29 (IP directa)
   └── Verificas que funciona desde el celular/navegador

3. PRODUCCIÓN (con dominio)
   └── Creas registro A en Newbox → subdominio.iamet.mx → 82.223.44.29
   └── Actions → Run workflow → ingresas el subdominio
   └── GitHub genera Nginx config + certificado SSL automáticamente
   └── App disponible en https://subdominio.iamet.mx
```

---

## Servicios activos en el VPS

| Contenedor | Puerto interno | Nginx expone en | Estado |
|---|---|---|---|
| `ai-command-bridge-panel` | 8080 | `82.223.44.29` (pruebas) | ✅ Activo |
| `iamet-website` | 3001 | `iamet.mx` | ✅ Activo |
| `iamet-cableado` | 3003 | `cableado.iamet.mx` | ✅ Activo |
| `crm-iamet-web-1` | 8007 | `crm.iamet.mx` | ✅ Activo |
| `gesti-n-de-ventas-web-1` | 8000 | `nethive.mx` | ✅ Activo |
| `gesti-n-de-ventas-db-1` | 3306 | interno | ✅ Activo |

### Puertos internos disponibles para nuevos proyectos
`8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090`

---

## Nginx configs en el VPS

| Archivo | server_name | Proxy a |
|---|---|---|
| `nethive` | nethive.mx, www.nethive.mx | :8000 |
| `iamet.mx` | iamet.mx, www.iamet.mx | :3001 |
| `cableado.iamet.mx.conf` | cableado.iamet.mx | :3003 |
| `crm.iamet.mx` | crm.iamet.mx | :8007 |
| `bridge` | 82.223.44.29 *(rotativo)* | :8080 |

> **Nota:** El config `bridge` con `server_name 82.223.44.29` es rotativo.
> Cada proyecto nuevo en pruebas reemplaza ese config apuntando a su puerto.
> Cuando se asigna dominio definitivo, `server_name` se cambia al subdominio.

---

## Archivos requeridos en cada proyecto nuevo

Para que GitHub Actions haga el deploy correctamente, cada proyecto debe tener esta estructura mínima:

```
mi-proyecto/
├── .github/
│   └── workflows/
│       └── deploy.yml          ← CI/CD (copiar y adaptar de este repo)
│
├── frontend_vps/               ← Lo que se despliega en el VPS
│   ├── Dockerfile              ← OBLIGATORIO
│   ├── docker-compose.yml      ← OBLIGATORIO
│   ├── nginx/
│   │   └── default.conf        ← Config interna del contenedor Nginx
│   └── public/
│       └── index.html          ← App estática (o build del framework)
│
└── backend_mac/                ← Motor local (si aplica)
    ├── server.js
    └── package.json
```

### Dockerfile mínimo (app estática)
```dockerfile
FROM nginx:alpine
COPY public/ /usr/share/nginx/html/
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### docker-compose.yml mínimo
```yaml
version: "3.8"
services:
  panel:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: nombre-del-proyecto
    restart: unless-stopped
    ports:
      - "PUERTO_INTERNO:80"   # ej: 8081:80, 8082:80, etc.
```

### nginx/default.conf mínimo
```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### deploy.yml — pasos que debe incluir
```yaml
script: |
  # 1. Clonar o actualizar el repo
  if [ ! -d "$HOME/mi-proyecto/.git" ]; then
    git clone https://github.com/DiegoRiv7/mi-proyecto.git $HOME/mi-proyecto
  else
    cd $HOME/mi-proyecto && git pull origin main
  fi

  # 2. Levantar contenedor
  cd $HOME/mi-proyecto/frontend_vps
  docker compose down --remove-orphans
  docker compose up -d --build

  # 3. Actualizar Nginx con IP para pruebas
  sudo tee /etc/nginx/sites-available/bridge > /dev/null <<NGINXCONF
server {
    listen 80;
    server_name 82.223.44.29;
    location / {
        proxy_pass http://127.0.0.1:PUERTO_INTERNO;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
NGINXCONF
  sudo ln -sf /etc/nginx/sites-available/bridge /etc/nginx/sites-enabled/bridge
  sudo nginx -t && sudo systemctl reload nginx

  echo "✅ Deploy completado — ver en http://82.223.44.29"
```

---

## CI/CD — GitHub Actions

**Archivo:** `.github/workflows/deploy.yml`

### Secrets requeridos en GitHub (por repo)

| Secret | Descripción |
|---|---|
| `VPS_HOST` | `82.223.44.29` |
| `VPS_USER` | Usuario SSH del VPS |
| `VPS_SSH_KEY` | Clave privada SSH completa |
| `VPS_PORT` | `22` |
| `BRIDGE_DOMAIN` | *(opcional)* Subdominio cuando pase a producción |
| `CERTBOT_EMAIL` | *(opcional)* Email para certificados SSL |

### Triggers
- **Push a `main`** → deploy automático → visible en `http://82.223.44.29`
- **Manual con dominio** → `Actions → Run workflow → ingresar subdominio` → Nginx + SSL automático

---

## Cómo pasar un proyecto a producción con dominio

```
1. Crear registro A en Newbox:
   Tipo: A | Nombre: subdominio | Valor: 82.223.44.29 | TTL: 300

2. En GitHub:
   Actions → Deploy to VPS → Run workflow → ingresar "subdominio.iamet.mx"

3. El workflow hace automáticamente:
   ✅ Actualiza el config Nginx con el subdominio
   ✅ Genera certificado SSL con Certbot
   ✅ App disponible en https://subdominio.iamet.mx
```

---

## Seguridad

- Puerto 80/443 son los únicos expuestos externamente (Ionos)
- SSH solo por clave privada (sin password)
- Contenedores Docker aislados en red interna
- PIN de acceso en el frontend del bridge (`MASTER_PIN` en `server.js`)
- Recomendado: mover PIN a `.env` con `dotenv` antes de producción

---

## Pendientes antes de producción

- [ ] Mover `MASTER_PIN` a `.env` con `dotenv`
- [ ] Crear registro DNS `bridge.iamet.mx` en Newbox
- [ ] Asignar dominio via GitHub Actions workflow_dispatch
- [ ] Actualizar `MAC_HUB_URL` en `public/index.html` cuando cambie el túnel Cloudflare
- [ ] Implementar lógica real de IA (reemplazar `exec()` con llamadas a APIs)
