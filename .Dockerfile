# Imagen oficial de Playwright con navegadores y dependencias del sistema ya instaladas
# Ajusta la versión (v1.46.0-jammy) si usas otra en package.json
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

# Copiamos solo los manifiestos para aprovechar la cache
COPY package*.json ./

# Importante: ignorar scripts de npm en la instalación para evitar que se ejecute
# "npx playwright install --with-deps chromium" del postinstall (si existe).
# La imagen ya trae navegadores y dependencias del sistema, no hace falta --with-deps.
RUN npm_config_ignore_scripts=true npm ci

# Copiamos el resto del código
COPY . .

# Si tu app necesita compilar algo:
# RUN npm run build

# Render inyecta la variable PORT; asegúrate de que tu app la respete.
# EXPOSE es informativo
EXPOSE 3000

# Arranque
CMD ["npm", "start"]