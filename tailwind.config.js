/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./privacidad.html",
    "./assets/js/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          burdeo: "#751318",
          burdeoHover: "#5e0f13",
          navySlate: "#162238",
          navyCardTitle: "#1b2c47",
          navySection: "#21324d",
          navyDark: "#172338",
        },
      },
      fontFamily: {
        sans: ["Montserrat", "system-ui", "-apple-system", "sans-serif"],
        display: ["Montserrat", "sans-serif"],
      },
    },
  },
};
