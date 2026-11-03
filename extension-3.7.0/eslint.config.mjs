import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', '**/*.d.ts'],
  },
  {
    files: ['src/**/*.ts'],
    extends: tseslint.configs.recommended,
    languageOptions: {
      parserOptions: {
        ecmaVersion: 6,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
