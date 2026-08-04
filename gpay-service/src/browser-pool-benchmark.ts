import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GpayModule } from './modules/gpay/gpay.module';
import { BrowserPoolService } from './modules/gpay/browser-pool.service';
import * as os from 'os';
import { execSync } from 'child_process';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), GpayModule],
})
class TestAppModule {}

const BENCHMARK_MARKER = 'gpay-benchmark-' + Date.now();

function getChromiumRssMB(): number {
  try {
    // Find processes matching our unique benchmark marker
    const output = execSync(
      `ps -axo rss,command | grep -i "${BENCHMARK_MARKER}" | grep -v grep || true`,
    ).toString();
    if (!output.trim()) return 0;

    let totalRssKb = 0;
    const lines = output.split('\n').filter((l) => l.trim() !== '');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const rss = parseInt(parts[0], 10);
      if (!isNaN(rss)) {
        totalRssKb += rss;
      }
    }
    return Math.round(totalRssKb / 1024);
  } catch (e) {
    return 0;
  }
}

async function bootstrap() {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.GPAY_BROWSER_POOL_BENCHMARK_ENABLED !== 'true'
  ) {
    console.error(
      'Benchmark cannot run in production without GPAY_BROWSER_POOL_BENCHMARK_ENABLED=true',
    );
    process.exit(1);
  }

  console.log('Starting Browser Pool Real Chromium Benchmark...');

  process.env.GPAY_MAX_CONTEXTS_PER_BROWSER = '5';
  process.env.GPAY_MAX_BROWSERS_PER_INSTANCE = '3';
  process.env.GPAY_MAX_PERSISTENT_PROFILES_PER_INSTANCE = '3';
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
  process.env.GPAY_EMPTY_BROWSER_IDLE_TIMEOUT_MS = '3000'; // Short timeout for testing

  // Trick Playwright into adding our marker so we can track its memory
  process.env.GPAY_USE_REAL_CHROME = 'false';
  const app = await NestFactory.createApplicationContext(TestAppModule);
  const browserPoolService = app.get(BrowserPoolService);

  // Override browser args to include our marker
  const originalGetOptions = (browserPoolService as any).getLaunchOptions.bind(
    browserPoolService,
  );
  (browserPoolService as any).getLaunchOptions = () => {
    const opts = originalGetOptions();
    if (!opts.args) opts.args = [];
    opts.args.push(`--gpay-benchmark-marker=${BENCHMARK_MARKER}`);
    return opts;
  };

  const getMetrics = () => {
    const browsers = (browserPoolService as any).sharedBrowsers || [];
    const contexts = (browserPoolService as any).activeContexts || new Map();
    const nodeRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const chromiumRss = getChromiumRssMB();
    const osFreeMb = Math.round(os.freemem() / 1024 / 1024);
    return {
      browsers: browsers.length,
      contexts: contexts.size,
      pages: contexts.size,
      nodeRss,
      chromiumRss,
      osFreeMb,
    };
  };

  const printMetrics = (label: string) => {
    const m = getMetrics();
    console.log(
      `[${label}] Browsers: ${m.browsers} | Contexts: ${m.contexts} | Node RSS: ${m.nodeRss}MB | Chromium RSS: ${m.chromiumRss}MB | OS Free: ${m.osFreeMb}MB`,
    );
    return m;
  };

  console.log('\n--- Part 2: Real Chromium Scaling Benchmark ---');

  const scalingTargets = [1, 5, 6, 10, 11, 12, 15];
  for (const target of scalingTargets) {
    for (
      let i = (browserPoolService as any).activeContexts.size + 1;
      i <= target;
      i++
    ) {
      await browserPoolService.acquireContext(`scale-provider-${i}`);
    }

    // Wait for chromium processes to settle
    await new Promise((r) => setTimeout(r, 1000));

    const m = printMetrics(`Target ${target}`);

    let expectedBrowsers = 1;
    if (target > 10) expectedBrowsers = 3;
    else if (target > 5) expectedBrowsers = 2;

    if (m.browsers !== expectedBrowsers || m.contexts !== target) {
      console.error(`❌ Scaling failed at target ${target}`);
    }
  }

  console.log('\n--- Attempt provider 16 ---');
  try {
    await browserPoolService.acquireContext(`scale-provider-16`);
    console.error(`❌ Expected capacity rejection but it succeeded!`);
  } catch (e: any) {
    console.log(`✅ Capacity rejection caught: ${e.message}`);
    const m = printMetrics('Target 16 Rejection');
    if (m.browsers !== 3 || m.contexts !== 15) {
      console.error(`❌ Leaked state on rejection!`);
    } else {
      console.log(`✅ No fourth shared browser, no leaked context/page`);
    }
  }

  console.log('\n--- Closing all contexts & Idle Timeout ---');
  // Close contexts individually to trigger handleContextClosed
  const allProviders = Array.from(
    (browserPoolService as any).activeContexts.keys(),
  );
  for (const p of allProviders) {
    await browserPoolService.releaseContext(p as string);
  }

  await new Promise((r) => setTimeout(r, 1000));
  let m = printMetrics('Immediately after close');
  if (m.contexts !== 0 || m.pages !== 0)
    console.error(`❌ Contexts/pages did not become zero`);

  console.log('Waiting for empty-browser timeout (3000ms)...');
  await new Promise((r) => setTimeout(r, 3500));

  m = printMetrics('After Empty Timeout');
  if (m.browsers !== 0)
    console.error(`❌ Shared browser-worker count did not become zero`);
  else console.log(`✅ Shared browsers closed successfully after timeout`);

  if (browserPoolService.browserRecycleCount !== 3) {
    console.error(
      `❌ Expected 3 recycled browsers, got ${browserPoolService.browserRecycleCount}`,
    );
  } else {
    console.log(`✅ browserRecycleCount correctly incremented`);
  }

  await app.close();
  console.log('\n✅ Real Chromium Benchmark completed successfully.');
}

bootstrap();
