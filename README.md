# Buscador CNV

App estática (un solo `index.html`, sin build) para buscar y descargar
presentaciones de una emisora en la CNV Argentina. Corre 100% en el
navegador — no necesita servidor propio.

## Cómo funciona

1. Traés el listado de presentaciones de una empresa por CUIT, filtrando
   por fecha y/o por texto en la descripción (tipo de documento).
2. Elegís una o varias filas con checkbox — a mano, o con ayuda de una IA
   externa (ver más abajo).
3. Descargás todo lo elegido como un único `.zip`.

### Elegir filas con ayuda de una IA (sin API, sin costo)

La app **no llama a ninguna IA por su cuenta** — no usa ninguna clave de
API ni depende de ninguna cuenta. En cambio, te da los datos para que uses
la IA que ya tengas a mano (ChatGPT, Claude, Gemini, la que sea), en dos
pasos manuales:

1. Después de buscar, apretás **"Descargar descripciones (.md)"**. Se baja
   un archivo Markdown con la lista numerada de `[fecha] descripción` de
   los resultados actuales, más instrucciones precisas para que una IA
   sepa cómo leer esa lista y qué formato de respuesta devolver.
2. Subís (o pegás) ese archivo en tu app de IA, junto con una frase tuya
   describiendo qué estás buscando (ej: "elegí las que hablan de aumento
   de capital"). La IA te va a devolver algo como `[2,5,11]`.
3. Volvés a la app, apretás **"Cargar selección de la IA"**, pegás esa
   respuesta, y quedan tildados los checkboxes correspondientes — listos
   para descargar.

Como el archivo `.md` ya incluye la lista completa y las instrucciones de
formato, cualquier persona que use esta herramienta puede hacer este paso
con la IA que prefiera, sin que la app dependa de ninguna cuenta ni clave.

Los pedidos a `www.cnv.gov.ar` y `aif2.cnv.gov.ar` pasan por un proxy CORS
público (necesario porque esos sitios no están pensados para ser
consultados desde otro dominio). La descarga final del PDF sí le pega
directo a `blob.cnv.gov.ar`, que permite pedidos cruzados sin proxy.

**Importante:** si el proxy público que uso (`corsproxy.io`, con
`allorigins.win` como respaldo) está caído o lento, la búsqueda puede
fallar o demorar. Se puede cambiar agregando otro proxy a la lista
`PROXIES` al principio del `<script>` en `index.html`.

## Publicar en GitHub Pages

**Paso 0 (recomendado): tu propio proxy en Cloudflare Workers**

Los proxies CORS públicos (allorigins, codetabs, corsproxy.io) son
gratuitos pero poco confiables — algunos exigen cuenta ahora, otros
pueden estar bloqueados según tu red o caídos sin aviso. Para una
experiencia estable, armá tu propio proxy en 5 minutos:

1. Creá una cuenta gratis en https://dash.cloudflare.com/sign-up (sin tarjeta).
2. Workers y Pages → Crear aplicación → Crear Worker. Ponele un nombre
   (ej. `cnv-proxy`) y desplegalo con el código de ejemplo.
3. Editar código → borrá todo y pegá el contenido de `cloudflare-worker.js`
   (incluido en esta carpeta) → Guardar y desplegar.
4. Copiá la URL que te da (ej. `https://cnv-proxy.tu-usuario.workers.dev`).
5. En `index.html`, buscá la línea `const MI_WORKER = '';` cerca del
   principio del `<script>` y pegá tu URL ahí adentro:
   ```js
   const MI_WORKER = 'https://cnv-proxy.tu-usuario.workers.dev';
   ```

Si dejás `MI_WORKER` vacío, la app va a intentar con los proxies
públicos igual (menos confiable, pero funciona como respaldo).

**Publicar la app**

1. Creá un repositorio nuevo en GitHub (público, para que Pages sea gratis).
2. Subí `index.html` (con tu `MI_WORKER` ya cargado) y este `README.md`:
   ```bash
   git init
   git add index.html README.md
   git commit -m "Buscador CNV"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
   git push -u origin main
   ```
3. En GitHub: **Settings → Pages → Build and deployment → Source**,
   elegí **Deploy from a branch**, rama `main`, carpeta `/ (root)`, Save.
4. Esperá 1-2 minutos. Tu app va a quedar en:
   `https://TU-USUARIO.github.io/TU-REPO/`

## Limitaciones conocidas

- Sitios pesados: el listado completo de una empresa puede tardar
  1-2 minutos en traerse (la página de la CNV es grande).
- El proxy CORS público puede tener límites de uso; para uso intensivo,
  considerá correr tu propio proxy (por ejemplo, un Cloudflare Worker
  de 5 líneas) y reemplazar la lista `PROXIES`.
- Si la CNV cambia la estructura de su sitio, los selectores/regex en
  `index.html` van a necesitar ajustarse (son los mismos que en el
  script de Python original).
