# Compushop

E-commerce fullstack: **React + Chakra UI** (frontend) y **Node.js + Express + JWT** (backend).

## URLs de producción

| Servicio  | URL |
|-----------|-----|
| Frontend  | https://front-compushop.vercel.app |
| Backend   | https://compushop-ruby.vercel.app |

## Credenciales demo

| Rol     | Email                 | Password   |
|---------|-----------------------|------------|
| Admin   | admin@compushop.com   | admin123   |
| Cliente | juan@email.com        | cliente123 |

---

## Desarrollo local

```bash
# Backend
cd backend
cp .env.example .env
npm install
npm run seed
npm start
# → http://localhost:4000

# Frontend (otra terminal)
cd frontend
cp .env.example .env
# En .env local usá: VITE_API_URL=http://localhost:4000/api
npm install
npm run dev
# → http://localhost:5173
```

---

## Deploy en Vercel

### 1. Subir a GitHub

```bash
git init
git branch -M main
git remote add origin https://github.com/TU_USUARIO/compushop.git
git add .
git commit -m "Compushop listo para deploy"
git push -u origin main
```

### 2. Backend (proyecto Vercel separado)

- **Root Directory:** `backend`
- Framework: Other
- Build: (dejar vacío o `npm install`)
- Variables de entorno:

| Name | Value |
|------|--------|
| `JWT_SECRET` | un secreto largo y aleatorio |
| `FRONTEND_URL` | `https://front-compushop.vercel.app` |
| `JWT_EXPIRES_IN` | `7d` |

Después del primer deploy, anotá la URL (ej. `https://compushop-ruby.vercel.app`).

En el servidor, ejecutá el seed una vez si no hay datos (o incluí seed en el arranque).

### 3. Frontend (proyecto Vercel separado)

- **Root Directory:** `frontend`
- **Framework Preset:** Vite
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- Variable de entorno (obligatoria):

| Name | Value |
|------|--------|
| `VITE_API_URL` | `https://compushop-ruby.vercel.app/api` |

> Sin esta variable el build no apunta al backend de producción.  
> Después de cambiar variables, hacé **Redeploy**.

### 4. Verificar

1. Abrí el frontend → Login  
2. Network: el request debe ir a `…/api/auth/login`  
3. Credenciales admin de prueba

---

## Estructura

```
compushop/
├── backend/          # API Express + JWT
│   ├── api/index.js  # Entry Vercel serverless
│   ├── vercel.json
│   └── src/
└── frontend/         # Vite + React + Chakra
    ├── vercel.json   # SPA rewrites
    └── src/
```
