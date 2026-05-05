/**
 * Backfill LearningEpisode rows for every historical StudentSession that
 * doesn't yet have an episodeId.
 *
 * Usage:
 *   pnpm --filter @ats/api run backfill-episodes -- [--dry-run] [--batch-size=500]
 *
 * Idempotent — re-runnable safely. Sessions with non-null episodeId are
 * skipped.
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { EpisodeGroupingService } from '../src/learning-episode/episode-grouping.service';

interface CliArgs {
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, batchSize: 500 };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a.startsWith('--batch-size=')) {
      const n = parseInt(a.slice('--batch-size='.length), 10);
      if (Number.isFinite(n) && n > 0) args.batchSize = n;
    } else if (a === '--help' || a === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        'Usage: backfill-episodes [--dry-run] [--batch-size=500]\n' +
          '  --dry-run         Count what would be assigned without writing.\n' +
          '  --batch-size=N    Sessions to fetch per batch (default 500).',
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const cli = parseArgs(process.argv);
  const logger = new Logger('backfill-episodes');
  logger.log(`Starting backfill (dryRun=${cli.dryRun} batchSize=${cli.batchSize})`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const service = app.get(EpisodeGroupingService);

  const start = Date.now();
  const result = await service.backfillAllSessions({
    dryRun: cli.dryRun,
    batchSize: cli.batchSize,
  });
  const elapsedSec = Math.round((Date.now() - start) / 1000);

  // eslint-disable-next-line no-console
  console.log('\n=== backfill complete ===');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ...result, elapsedSec, dryRun: cli.dryRun }, null, 2));

  await app.close();
  // Force-exit because some downstream connections (Redis / pg) may keep
  // the loop alive otherwise.
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('backfill-episodes failed:', err);
  process.exit(1);
});
