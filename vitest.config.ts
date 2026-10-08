import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],

		// Loading a 4 MiB plugin script into QuickJS takes a couple of hundred milliseconds, and the
		// live tests make real network requests.
		testTimeout: 120_000,
		hookTimeout: 120_000
	}
});
