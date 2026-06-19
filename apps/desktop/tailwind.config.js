/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: '#15161a', elevated: '#1b1d22', overlay: '#262931' },
        border: { DEFAULT: '#2a2d34' },
        text: { primary: '#e9e9ec', muted: '#8a8d96' },
        accent: { amber: '#E8A33D', red: '#E5484D' },
      },
    },
  },
  plugins: [],
};
