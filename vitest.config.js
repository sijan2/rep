import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files location
    include: ['tests/**/*.test.js'],
    // Environment - use jsdom for DOM-related tests
    environment: 'jsdom',
    // Setup files
    setupFiles: ['tests/setup.js'],
    // Coverage (optional, for future use)
    coverage: {
      exclude: [
        'node_modules/',
        'tests/',
        'lib/',
        '*.config.js'
      ]
    }
  }
});

