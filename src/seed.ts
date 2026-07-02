import { config } from './config.js'
import { seedFirstUser } from './auth.js'

/**
 * Standalone seed script: `npm run seed`.
 * Creates the configured SEED_USERNAME/SEED_PASSWORD user if the table is empty.
 * The backend also runs this automatically on boot; this script is for
 * provisioning a fresh DB without starting the server.
 */
async function main(): Promise<void> {
  const created = await seedFirstUser()
  if (created) {
    console.log(`[seed] created user "${config.seedUsername}"`)
  } else {
    console.log('[seed] users table already populated, nothing to do')
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
