import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/core/jobs/**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: { project: './tsconfig.jobs.json' }
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error'
    }
  }
];
