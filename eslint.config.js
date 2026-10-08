import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig(
	{ ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
	js.configs.recommended,
	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				// `allowDefaultProject` covers this file itself: it is JavaScript, so the TypeScript project
				// service will not claim it even though `tsconfig.json` lists it, and without this the only
				// error ESLint reports is about its own configuration.
				projectService: { allowDefaultProject: ['eslint.config.js'] },
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
			'no-console': 'error'
		}
	},
	{
		// The bootstrap is a template literal of guest JavaScript, not TypeScript to be linted.
		files: ['src/bootstrap.ts'],
		rules: { 'max-lines': 'off' }
	},
	{
		files: ['**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off'
		}
	}
);
