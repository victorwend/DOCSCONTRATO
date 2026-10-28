import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#FCE94F', 50: '#FFFCE5', 100: '#FEF7BF', 400: '#FCE94F', 500: '#F2DC1F', 600: '#C9B40B' },
        ink: { DEFAULT: '#1F1F1F', 600: '#3A3A3A', 700: '#2A2A2A', 900: '#141414' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      boxShadow: { card: '0 1px 2px rgba(16,16,16,.06), 0 1px 3px rgba(16,16,16,.08)' },
    },
  },
  plugins: [],
} satisfies Config;
