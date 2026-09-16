# Sincro Soluciones Legales

Landing page profesional para el estudio jurídico **Sincro Soluciones Legales** (Álvaro Quijero).

## Tecnologías Utilizadas
- HTML5 semántico
- Tailwind CSS 3.4.17 (CSS estático compilado)
- Lucide Icons
- JavaScript nativo (ES6+)

## Compilar Tailwind CSS

Este proyecto usa el CLI standalone de Tailwind CSS `v3.4.17`; no requiere `package.json` ni un build en Vercel.

Desde PowerShell, con `tailwindcss.exe` en la raíz del repositorio, regenera el CSS con:

```powershell
.\tailwindcss.exe -c .\tailwind.config.js -i .\assets\css\tailwind-input.css -o .\assets\css\tailwind.css --minify
```

El archivo generado `assets/css/tailwind.css` debe versionarse junto con los cambios de clases o configuración. El ejecutable local está excluido por `.gitignore`.

## Despliegue
Este repositorio está optimizado para su entrega continua mediante GitHub Pages o Vercel.
