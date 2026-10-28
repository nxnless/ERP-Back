import { sql } from './src/shared/db'
try {
  const users = await sql`SELECT id, email, display_name, status FROM platform.users LIMIT 5`
  console.log('USERS FOUND:', users)
} catch (e) {
  console.error('DB ERROR:', e)
}

