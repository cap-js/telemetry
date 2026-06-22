import { defineConfig } from 'vitest/config'

const isHana = process.env.CI && process.env.HANA_DRIVER

if (isHana && process.env.HANA_PROM)
  process.env.cds_requires_telemetry_tracing = JSON.stringify({ _hana_prom: process.env.HANA_PROM === 'true' })

export default defineConfig({
  test: {
    globals: true,
    testTimeout: isHana ? 420000 : 42000,
    include: isHana ? ['**/tracing-attributes.test.js', '**/passport.test.js'] : ['**/*.test.js'],
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true
      }
    }
  }
})
