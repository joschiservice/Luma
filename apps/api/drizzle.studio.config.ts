import { defineConfig } from 'drizzle-kit';

const url = process.env.LUMA_STUDIO_DATABASE_URL;
if (!url) throw new Error('Run pnpm db:studio from the repository root.');

export default defineConfig({
  dialect: 'postgresql',
  dbCredentials: { url },
});
