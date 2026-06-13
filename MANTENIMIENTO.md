# Mantenimiento — Polla Mundial 2026

Guía rápida de tareas de administración. Todo se hace desde la **consola de Firebase**
(console.firebase.google.com → proyecto polla-mundial-2026 → Firestore Database),
sin tocar código.

---

## Resetear el dispositivo del admin (Carlos Esteban cambió de PC/celular)

1. Firestore → colección `config` → documento `global`.
2. Busca el campo `adminUid` → edítalo → déjalo en `null` (o bórralo).
3. Guarda.

La próxima vez que Carlos Esteban entre a la app, vaya a Admin y meta el PIN,
su nuevo dispositivo queda sellado como admin automáticamente.

---

## Liberar un nombre (alguien perdió acceso o reclamó el equivocado)

1. Firestore → colección `participants` → documento de esa persona
   (ej: `aliria`, `juan-david`).
2. Campo `claimedByUid` → déjalo en `null`.
3. Guarda.

Ese nombre vuelve a aparecer disponible en la pantalla "¿Quién eres?".

---

## Cambiar / resetear el PIN de admin

El PIN se guarda como hash (no se puede leer). Para ponerle uno nuevo:

1. Calcula el hash del nuevo PIN. Abre la consola del navegador (F12) en
   cualquier página y pega (cambia 1234 por tu PIN):
   ```js
   crypto.subtle.digest('SHA-256', new TextEncoder().encode('1234'))
     .then(h => console.log(Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('')));
   ```
2. Copia el texto largo que imprime.
3. Firestore → `config/global` → campo `adminPinHash` → pega el hash nuevo → guarda.

---

## Corregir un resultado mal cargado

Mejor desde la app: Admin → Resultados → Borrar resultado / volver a cargar.
O directo en Firestore: `matches/{id}` → `colombiaGoals` y `opponentGoals`.
Si quieres que vuelva a contar como "no jugado", ponlos en `null` y `status` en `open`.

---

## Arreglar la hora de un partido

Firestore → `matches/{id}` → `kickoffUtc` y `predictionDeadlineUtc`.
**Ojo:** se guardan en UTC, que es hora Colombia + 5 horas.
Ej: un partido a las 3:00 PM Colombia se guarda como 20:00 (8 PM) UTC.
El deadline siempre es 1 hora antes del kickoff.

---

## Si la app deja de guardar predicciones de todos a la vez

Probablemente venció el "modo de prueba" de Firestore o hay un problema con las
reglas. Revisa Firestore → pestaña Reglas. Deben ser las del archivo
`firestore.rules`. Si algo se rompió, vuelve a pegarlas y publica.

---

## Archivos del proyecto

- `index.html`, `styles.css`, `app.js` → la app (esto es lo que se sube a GitHub Pages).
- `firestore.rules` → reglas de seguridad (se pegan en la consola, NO se suben).
- `seed.html`, `add-admin-field.html` → utilidades de un solo uso. NO subir. Borrar tras usar.
