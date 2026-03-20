import verdaccioConfig, {vitestConfig} from '@verdaccio/eslint-config';
import {defineConfig, globalIgnores} from 'eslint/config';

export default defineConfig([
  ...verdaccioConfig,
  ...vitestConfig,
  globalIgnores(['new_structure/', 'coverage/', '*.config.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]);
