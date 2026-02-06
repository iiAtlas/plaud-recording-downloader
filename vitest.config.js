import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'extension/lib/plaud-api.js',
        'extension/lib/id3.js',
        'extension/lib/messaging.js'
      ]
    }
  }
});
