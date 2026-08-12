/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A quiet, paper-like palette: this is a tool for reading long-form
        // notes for hours, so contrast is kept high and hue kept out of the way.
        canvas: '#fbfaf8',
        panel: '#ffffff',
        ink: '#1c1a17',
        muted: '#6b6862',
        line: '#e5e1da',
        accent: '#2f6f5e',
        'accent-soft': '#e8f1ee',
        flag: '#a4501e',
        'flag-soft': '#fbeee4',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['Charter', 'Georgia', 'ui-serif', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
