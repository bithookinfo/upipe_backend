import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BrowserPoolService } from './browser-pool.service';

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockImplementation(() =>
      Promise.resolve({
        on: jest.fn(),
        close: jest.fn(),
        newContext: jest.fn().mockImplementation(() =>
          Promise.resolve({
            on: jest.fn(),
            close: jest.fn(),
            newPage: jest.fn().mockResolvedValue({}),
          }),
        ),
      }),
    ),
    launchPersistentContext: jest.fn().mockImplementation(() =>
      Promise.resolve({
        on: jest.fn(),
        close: jest.fn(),
        pages: jest.fn().mockReturnValue([{}]),
        newPage: jest.fn().mockResolvedValue({}),
      }),
    ),
  },
}));

describe('BrowserPoolService', () => {
  let service: BrowserPoolService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrowserPoolService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'GPAY_MAX_CONTEXTS_PER_BROWSER') return '2';
              if (key === 'GPAY_MAX_BROWSERS_PER_INSTANCE') return '2';
              if (key === 'GPAY_MAX_PERSISTENT_PROFILES_PER_INSTANCE') return '2';
              if (key === 'GPAY_NODE_ID') return 'test-node-1';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<BrowserPoolService>(BrowserPoolService);
    configService = module.get<ConfigService>(ConfigService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.closeAll();
  });

  it('should allocate multiple browser workers when maxContextsPerBrowser is reached', async () => {
    const ctx1 = await service.acquireContext('provider-1');
    const ctx2 = await service.acquireContext('provider-2');
    expect(ctx1.browserId).toBe(ctx2.browserId);

    const ctx3 = await service.acquireContext('provider-3');
    expect(ctx3.browserId).not.toBe(ctx1.browserId);
  });

  it('should respect max browsers per instance and use least loaded when at capacity', async () => {
    const ctx1 = await service.acquireContext('provider-1');
    await service.acquireContext('provider-2');
    await service.acquireContext('provider-3');
    await service.acquireContext('provider-4');

    // Both browsers are now at capacity (2 contexts each). Acquiring a 5th should use least loaded without creating a 3rd browser.
    const ctx5 = await service.acquireContext('provider-5');
    expect(service['sharedBrowsers'].length).toBe(2);
    expect(ctx5.browserId).toBeDefined();
  });

  it('should enforce persistent-profile capacity bounds', async () => {
    await service.acquireContext('persistent-1', undefined, {
      requiresPersistentProfile: true,
    });
    await service.acquireContext('persistent-2', undefined, {
      requiresPersistentProfile: true,
    });

    await expect(
      service.acquireContext('persistent-3', undefined, {
        requiresPersistentProfile: true,
      }),
    ).rejects.toThrow(/Persistent profile capacity reached/);
  });

  it('should deduplicate duplicate provider activation and return existing context', async () => {
    const ctx1 = await service.acquireContext('provider-dup');
    const ctx2 = await service.acquireContext('provider-dup');
    expect(ctx1).toBe(ctx2);
  });
});
