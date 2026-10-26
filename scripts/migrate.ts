import { createOrm } from '../src/infrastructure/database/orm';

const command = process.argv[2] ?? 'up';
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const orm = await createOrm({ url, poolMax: 2 });
try {
  const migrator = orm.migrator;
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(JSON.stringify({ command, applied: applied.map((m) => m.name) }));
      break;
    }
    case 'down': {
      // Reverts every migration when called with "all", otherwise only the last one.
      const options = process.argv[3] === 'all' ? { to: 0 } : undefined;
      const reverted = await migrator.down(options);
      console.log(JSON.stringify({ command, reverted: reverted.map((m) => m.name) }));
      break;
    }
    case 'status': {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      console.log(
        JSON.stringify({
          executed: executed.map((m) => m.name),
          pending: pending.map((m) => m.name),
        }),
      );
      break;
    }
    default:
      console.error(`Unknown command "${command}". Use up, down [all] or status.`);
      process.exitCode = 1;
  }
} finally {
  await orm.close();
}
