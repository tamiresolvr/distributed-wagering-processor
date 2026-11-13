import { createOrm } from './infrastructure/db/database';
import { loadConfig } from './config';

/** Usage: bun run src/migrate.ts up|down */
export async function migrate(direction: 'up' | 'down'): Promise<void> {
  const orm = await createOrm(loadConfig());
  try {
    const migrator = orm.getMigrator();
    if (direction === 'up') await migrator.up();
    else await migrator.down();
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const dir = process.argv[2] === 'down' ? 'down' : 'up';
  migrate(dir).then(
    () => console.log(JSON.stringify({ msg: `migrations ${dir} done` })),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
