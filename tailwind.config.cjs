/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './App.tsx', './components/**/*.{ts,tsx}', './hooks/**/*.{ts,tsx}', './features/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Fredoka', 'sans-serif']
      },
      colors: {
        'kid-blue': '#4facfe',
        'kid-teal': '#00f2fe',
        'kid-orange': '#f093fb',
        'kid-pink': '#f5576c',
        'kid-yellow': '#fee140'
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.5s ease-out forwards'
      }
    }
  },
  plugins: []
};
