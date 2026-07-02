import bcrypt from 'bcryptjs'
import { config } from './config.js'
import { countUsers, createUser, findUserByUsername } from './db.js'

const SALT_ROUNDS = 10

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS)
}

/**
 * Verify a plaintext password against a stored bcrypt hash.
 * Returns false (never throws) on any comparison error.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

/**
 * Validate a username/password pair. Returns the username on success, null otherwise.
 * A dummy compare on the missing-user path keeps timing roughly uniform so an
 * attacker can't distinguish "no such user" from "wrong password".
 */
export async function authenticate(username: string, password: string): Promise<string | null> {
  const user = findUserByUsername(username)
  if (!user) {
    await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv')
    return null
  }
  const ok = await verifyPassword(password, user.password_hash)
  return ok ? user.username : null
}

/**
 * Create the seed user from config if (and only if) the users table is empty.
 * Idempotent: a no-op once any user exists. Returns true if a user was created.
 */
export async function seedFirstUser(): Promise<boolean> {
  if (countUsers() > 0) return false
  const hash = await hashPassword(config.seedPassword)
  createUser(config.seedUsername, hash)
  return true
}
