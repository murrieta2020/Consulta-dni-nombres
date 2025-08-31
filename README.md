# Scraper Playwright para Render (DNI Perú)

Este servicio Node.js usa Playwright (Chromium) para cargar la página con JavaScript y extraer resultados.

## Despliegue en Render
1. Crea un nuevo repositorio con estos archivos.
2. En Render, crea un "Web Service" desde tu repo.
3. Render detectará `render.yaml` y configurará:
   - build: `npm ci && npx playwright install --with-deps chromium`
   - start: `node server.js`
4. Establece variables de entorno:
   - TARGET_URL (ya incluida en render.yaml)
   - PROXY_URL (opcional, si necesitas un proxy)
5. Deploy. Verifica `/healthz` en tu URL de Render.

## Uso del API
- Endpoint: `POST https://<tu-servicio>.onrender.com/api/buscar`
- Body JSON:
```json
{ "nombres": "JUAN", "apellido_paterno": "PEREZ", "apellido_materno": "GARCIA" }
```
- Respuesta:
```json
{ "ok": true, "count": 2, "items": [ { "dni":"12345678","nombreCompleto":"..." } ] }
```

También acepta `GET` con query params para pruebas rápidas:
`https://<tu-servicio>.onrender.com/api/buscar?nombres=...&apellido_paterno=...&apellido_materno=...`

## Integración desde InfinityFree (frontend)
En tu `index.php` o JS del frontend cambia la llamada fetch a tu servicio en Render:

```html
<script>
async function buscar() {
  const nombres = document.getElementById('nombres').value.trim();
  const ap = document.getElementById('apellido_paterno').value.trim();
  const am = document.getElementById('apellido_materno').value.trim();

  const resp = await fetch('https://<tu-servicio>.onrender.com/api/buscar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombres, apellido_paterno: ap, apellido_materno: am })
  });
  const data = await resp.json();
  // renderiza data.items...
}
</script>
```

Asegúrate de que CORS esté habilitado (ya lo está en `server.js` con `app.use(cors())`).

## Notas
- Playwright ayuda a pasar desafíos JS de Cloudflare, pero no garantiza eludir todos los bloqueos. Si sigues bloqueado:
  - Usa `PROXY_URL` con IPs residenciales/rotativas.
  - Ajusta demoras y `waitForSelector` en `waitForResultsHeuristic`.
- Respeta términos de uso y privacidad del sitio objetivo.