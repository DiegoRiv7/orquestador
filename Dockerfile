FROM node:20-alpine

WORKDIR /app

# Copiar archivos de dependencias primero para aprovechar la caché de Docker
COPY package.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar el resto del código fuente
COPY . .

# Exponer el puerto de la aplicación
EXPOSE 3000

# Comando de arranque
CMD ["node", "server.js"]
