/**
 * Tailwind CSS v4 runs as a PostCSS plugin. There is no `tailwind.config.js`:
 * v4 discovers content automatically from the source tree, and the design
 * tokens live in `src/app/globals.css` under `@theme`.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
