import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BrowserPoolService } from '../../../../src/modules/gpay/browser-pool.service';

const mockBrowserClose = jest.fn();
const mockContextClose = jest.fn();

jest.mock('playwright', () => {
  return {
    chromium: {
      launch: jest.fn().mockImplementation(() => {
        const browserId = `mock-browser-${Date.now()}-${Math.random()}`;
        return Promise.resolve({
          on: jest.fn(),
          close: mockBrowserClose,
          newContext: jest.fn().mockImplementation(() =>
            Promise.resolve({
              on: jest.fn(),
              close: mockContextClose,
              newPage: jest.fn().mockResolvedValue({}),
            }),
          ),
        });
      }),
      launchPersistentContext: jest.fn().mockImplementation(() =>
        Promise.resolve({
          on: jest.fn(),
          close: jest.fn(),
          pages: jest.fn().mockReturnValue([{}]),
          newPage: jest.fn().mockResolvedValue({}),
        }),
      ),
    },
  };
});

describe('BrowserPoolService', () => {
  let service: BrowserPoolService;
  let configService: ConfigService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrowserPoolService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'GPAY_MAX_CONTEXTS_PER_BROWSER') return '5';
              if (key === 'GPAY_MAX_BROWSERS_PER_INSTANCE') return '3';
              if (key === 'GPAY_MAX_PERSISTENT_PROFILES_PER_INSTANCE')
                return '3';
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

  describe('Capacity and Load Balancing Tests', () => {
    // ## Test A: One provider
    it('Test A: One provider', async () => {
      await service.acquireContext('provider-1');
      expect((service as any).sharedBrowsers.length).toBe(1);
      expect((service as any).activeContexts.size).toBe(1);
    });

    // ## Test B: Five providers
    it('Test B: Five providers', async () => {
      for (let i = 1; i <= 5; i++) {
        await service.acquireContext(`provider-${i}`);
      }
      expect((service as any).sharedBrowsers.length).toBe(1);
      expect((service as any).activeContexts.size).toBe(5);
    });

    // ## Test C: Sixth provider
    it('Test C: Sixth provider', async () => {
      for (let i = 1; i <= 6; i++) {
        await service.acquireContext(`provider-${i}`);
      }
      expect((service as any).sharedBrowsers.length).toBe(2);
      expect((service as any).activeContexts.size).toBe(6);
    });

    // ## Test D: Ten providers
    it('Test D: Ten providers', async () => {
      for (let i = 1; i <= 10; i++) {
        await service.acquireContext(`provider-${i}`);
      }
      expect((service as any).sharedBrowsers.length).toBe(2);
      expect((service as any).activeContexts.size).toBe(10);
    });

    // ## Test E: Eleventh provider
    it('Test E: Eleventh provider', async () => {
      for (let i = 1; i <= 11; i++) {
        await service.acquireContext(`provider-${i}`);
      }
      expect((service as any).sharedBrowsers.length).toBe(3);
      expect((service as any).activeContexts.size).toBe(11);
    });

    // ## Test F: Fifteen providers
    it('Test F: Fifteen providers', async () => {
      for (let i = 1; i <= 15; i++) {
        await service.acquireContext(`provider-${i}`);
      }
      expect((service as any).sharedBrowsers.length).toBe(3);
      expect((service as any).activeContexts.size).toBe(15);
    });

    // ## Test G: Sixteenth provider
    it('Test G: Sixteenth provider', async () => {
      for (let i = 1; i <= 15; i++) {
        await service.acquireContext(`provider-${i}`);
      }

      await expect(service.acquireContext('provider-16')).rejects.toThrow(
        /Capacity Rejection: Maximum shared browsers/,
      );

      // browser count remains 3, context count remains 15
      expect((service as any).sharedBrowsers.length).toBe(3);
      expect((service as any).activeContexts.size).toBe(15);
    });

    // ## Test H: Least-loaded selection
    it('Test H: Least-loaded selection', async () => {
      // Simulate browser loads: A=5, B=2, C=4
      const browserA = {
        id: 'browser-A',
        browser: {
          newContext: jest.fn().mockResolvedValue({
            newPage: jest.fn().mockResolvedValue({}),
            on: jest.fn(),
          }),
        } as any,
        activeContextCount: 5,
      };
      const browserB = {
        id: 'browser-B',
        browser: {
          newContext: jest.fn().mockResolvedValue({
            newPage: jest.fn().mockResolvedValue({}),
            on: jest.fn(),
          }),
        } as any,
        activeContextCount: 2,
      };
      const browserC = {
        id: 'browser-C',
        browser: {
          newContext: jest.fn().mockResolvedValue({
            newPage: jest.fn().mockResolvedValue({}),
            on: jest.fn(),
          }),
        } as any,
        activeContextCount: 4,
      };

      (service as any).sharedBrowsers = [browserA, browserB, browserC];

      const targetBrowser = await (service as any).getLeastLoadedBrowser();
      expect(targetBrowser.id).toBe('browser-B');
    });

    // ## Test I: Duplicate provider activation
    it('Test I: Duplicate provider activation', async () => {
      const ctx1 = await service.acquireContext('provider-dup');
      const ctx2 = await service.acquireContext('provider-dup');

      expect(ctx1).toBe(ctx2);
      expect((service as any).sharedBrowsers.length).toBe(1);
      expect((service as any).activeContexts.size).toBe(1);
    });

    // ## Test J: Browser crash isolation
    it('Test J: Browser crash isolation', async () => {
      // Create 3 browsers by assigning 11 contexts
      for (let i = 1; i <= 11; i++) {
        await service.acquireContext(`provider-${i}`);
      }

      expect((service as any).sharedBrowsers.length).toBe(3);

      const browsers = (service as any).sharedBrowsers;
      const browserB = browsers[1];
      const browserBId = browserB.id;

      // Simulate browser B disconnect
      // We need to trigger the 'disconnected' event listener
      const disconnectHandlers = (
        service as any
      ).sharedBrowsers[1].browser.on.mock.calls
        .filter((call: any[]) => call[0] === 'disconnected')
        .map((call: any[]) => call[1]);

      for (const handler of disconnectHandlers) {
        handler();
      }

      // Browser B should be removed from sharedBrowsers array
      expect((service as any).sharedBrowsers.length).toBe(2);
      expect(
        (service as any).sharedBrowsers.find((b: any) => b.id === browserBId),
      ).toBeUndefined();
    });

    // ## Test K: Empty Browser Recycling
    it('Test K: final context close schedules browser recycling and empty timeout closes browser', async () => {
      jest.useFakeTimers();

      const ctx = await service.acquireContext('provider-recycle');
      expect((service as any).sharedBrowsers.length).toBe(1);

      const browserInstance = (service as any).sharedBrowsers[0];

      // Release context
      await service.releaseContext('provider-recycle');

      expect(browserInstance.activeContextCount).toBe(0);
      expect(browserInstance.recycleTimer).toBeDefined();
      expect(browserInstance.emptySince).toBeDefined();

      // Fast forward timeout
      jest.advanceTimersByTime(300000); // 5 mins
      await Promise.resolve(); // flush microtasks

      expect((service as any).sharedBrowsers.length).toBe(0);
      expect(service.browserRecycleCount).toBe(1);

      jest.useRealTimers();
    });

    // ## Test L: Cancel Recycling
    it('Test L: new assignment cancels recycling', async () => {
      jest.useFakeTimers();

      await service.acquireContext('provider-recycle-cancel');
      await service.releaseContext('provider-recycle-cancel');

      const browserInstance = (service as any).sharedBrowsers[0];
      expect(browserInstance.recycleTimer).toBeDefined();

      // Acquire new context before timeout
      await service.acquireContext('provider-new');

      expect(browserInstance.recycleTimer).toBeUndefined();
      expect(browserInstance.emptySince).toBeUndefined();
      expect(browserInstance.activeContextCount).toBe(1);

      jest.advanceTimersByTime(300000);
      await Promise.resolve();

      // Browser shouldn't be recycled
      expect((service as any).sharedBrowsers.length).toBe(1);

      jest.useRealTimers();
    });
  });
});
