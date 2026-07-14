/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Segoe UI", "sans-serif"],
        display: ["Space Grotesk", "Inter", "sans-serif"]
      }
    }
  },
  plugins: []
};
