FROM nginx:alpine

# Copiar el panel estático al directorio web de Nginx
COPY public/ /usr/share/nginx/html/

# Copiar configuración de Nginx
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
