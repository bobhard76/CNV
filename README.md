# Buscador CNV

App estática (un solo `index.html`, sin build) para buscar y descargar
presentaciones de una emisora en la CNV Argentina. Corre 100% en el
navegador — no necesita servidor propio.

## Cómo funciona

1. Ponés el CUIT, y opcionalmente fechas, un tipo de documento y, en el
   cuadro **"¿Qué necesitás encontrar?"**, todo lo que buscás (una búsqueda
   por renglón).
2. La app trae el listado de presentaciones de la CNV y, si completaste el
   cuadro, una IA marca qué presentaciones corresponden a cada búsqueda
   (columna **"Coincide con"**). Quedan tildadas y podés ver solo esas.
3. Revisás, ajustás a mano si hace falta, y descargás todo como un `.zip`.

### Búsqueda con IA (gratis, sin cuenta para los usuarios)

La IA corre en el mismo Cloudflare Worker que hace de proxy, usando
**Cloudflare Workers AI** (10.000 "neurons" gratis por día, alcanza para
varias decenas de búsquedas diarias). Las personas que usan la app no
necesitan cuenta ni clave: solo el dueño del Worker tiene la cuenta gratuita
de Cloudflare.

Para ahorrar cupo, la app manda cada descripción distinta una sola vez (muchas
presentaciones se llaman igual, p. ej. "HECHO RELEVANTE") y en tandas de 120.
Conviene usar los filtros de fecha para acotar antes de buscar con IA.

La IA solo ve la **descripción** de cada presentación, no el contenido de los
PDFs. Si lo que buscás no aparece en el título (p. ej. el tema de un "Hecho
Relevante"), no lo va a encontrar.

Opcionalmente se pueden cargar claves gratuitas de **Groq** y/o **Gemini**
como respaldo: si se agota el cupo diario de Cloudflare, el Worker pasa solo
al siguiente proveedor.

La alternativa manual (descargar un `.md` y pasárselo a cualquier IA) sigue
disponible en "Alternativa manual".

Los pedidos a `www.cnv.gov.ar` y `aif2.cnv.gov.ar` pasan por un proxy CORS
público (necesario porque esos sitios no están pensados para ser
consultados desde otro dominio). La descarga final del PDF sí le pega
directo a `blob.cnv.gov.ar`, que permite pedidos cruzados sin proxy.

**Importante:** si el proxy público que uso (`corsproxy.io`, con
`allorigins.win` como respaldo) está caído o lento, la búsqueda puede
fallar o demorar. Se puede cambiar agregando otro proxy a la lista
`PROXIES` al principio del `<script>` en `index.html`.

## Publicar en GitHub Pages

**Paso 0: tu Worker en Cloudflare (proxy + IA)**

1. Creá una cuenta gratis en https://dash.cloudflare.com/sign-up (sin tarjeta),
   o usá la que ya tenés.
2. Workers y Pages → Crear aplicación → Crear Worker (ej. `cnv-proxy`), o abrí
   el que ya existe.
3. Editar código → borrá todo y pegá el contenido de `cloudflare-worker.js`
   → Guardar y desplegar.
4. **Activar la IA:** en el Worker, Settings → Bindings → Add → **Workers AI**.
   Nombre de variable: `AI` → Guardar. (Sin este paso el proxy funciona pero
   la búsqueda con IA no.)
5. Verificá entrando a `https://TU-WORKER.workers.dev/estado`: tiene que
   decir `"cloudflare": true`.
6. En `index.html`, la línea `const MI_WORKER = '...';` tiene que tener la URL
   de tu Worker.
7. Si publicás la app en un dominio distinto de `https://bobhard76.github.io`,
   agregalo a `ORIGENES_PERMITIDOS` al principio de `cloudflare-worker.js`
   (evita que otras páginas usen tu cupo de IA).

**Respaldo opcional (Groq / Gemini):** en el Worker, Settings → Variables and
Secrets → Add → tipo *Secret*:
- `GROQ_API_KEY` — clave gratuita de https://console.groq.com/keys
- `GEMINI_API_KEY` — clave gratuita de https://aistudio.google.com/apikey

Para cambiar el modelo de Cloudflare, agregá una variable `CF_MODEL` (por
defecto `@cf/meta/llama-3.3-70b-instruct-fp8-fast`).

**Publicar la app**

1. Creá un repositorio nuevo en GitHub (público, para que Pages sea gratis).
2. Subí `index.html` (con tu `MI_WORKER` ya cargado), `cloudflare-worker.js` y este `README.md`:
   ```bash
   git init
   git add index.html README.md cloudflare-worker.js
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
- Cupo de IA: el gratuito de Cloudflare se renueva cada día (00:00 UTC). Un
  listado grande sin filtro de fechas consume más; si se agota, se usa Groq
  o Gemini si están configurados.
- Si la CNV cambia la estructura de su sitio, los selectores/regex en
  `index.html` van a necesitar ajustarse (son los mismos que en el
  script de Python original).
