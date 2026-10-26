const { defineConfig } = require('vite');
const path = require('path');

module.exports = defineConfig({
  root: path.join(__dirname, 'ui'),
  build: {
    outDir: path.join(__dirname, 'public'),
    emptyOutDir: true
  }
});
