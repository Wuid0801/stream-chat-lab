import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['**/node_modules/', '**/dist/', '**/coverage/']),
  js.configs.recommended,
  tseslint.configs.strict,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/mock-server/**/*.ts', '*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
])
