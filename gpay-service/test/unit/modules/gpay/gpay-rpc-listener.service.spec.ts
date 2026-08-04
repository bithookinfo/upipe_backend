import { Test, TestingModule } from '@nestjs/testing';
import { GpayRpcListenerService } from '../../../../src/modules/gpay/gpay-rpc-listener.service';
import { GpayRpcParserService } from '../../../../src/modules/gpay/gpay-rpc-parser.service';
import { RedisService } from '../../../../src/common/redis/redis.service';
import { GpayPaymentEventProducer } from '../../../../src/modules/gpay/queue/gpay-payment-event.producer';
import { ConfigService } from '@nestjs/config';
import { BrowserPoolService } from '../../../../src/modules/gpay/browser-pool.service';

describe('GpayRpcListenerService', () => {
  let service: GpayRpcListenerService;
  let mockRedisClient: { eval: jest.Mock };
  let mockEventProducer: { producePaymentEvent: jest.Mock };

  beforeEach(async () => {
    mockRedisClient = {
      eval: jest.fn().mockResolvedValue(1),
    };

    mockEventProducer = {
      producePaymentEvent: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GpayRpcListenerService,
        {
          provide: GpayRpcParserService,
          useValue: {
            parseBatchexecuteResponse: jest.fn().mockReturnValue([
              {
                transactionId: 'txn_123',
                amount: 100,
                timestamp: new Date(),
              },
            ]),
          },
        },
        {
          provide: RedisService,
          useValue: { getClient: () => mockRedisClient },
        },
        {
          provide: GpayPaymentEventProducer,
          useValue: mockEventProducer,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(3600) },
        },
        {
          provide: BrowserPoolService,
          useValue: { updateLastActivity: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<GpayRpcListenerService>(GpayRpcListenerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // Basic mock test for the bufferToRedis method via attachListener event simulating would be complex.
  // Instead, we just test that bufferToRedis executes the script properly.
  // We can access it by casting to any.
  it('should buffer to redis and return true for new txn', async () => {
    const txn = {
      txnId: 'txn_123',
      amount: 100,
      timestamp: new Date(),
      status: 'COMPLETED',
      customerName: 'A',
      customerVpa: 'a@vpa',
      utr: 'UTR',
      note: 'Note',
    };

    const isNew = await (service as any).bufferToRedis('prov_1', txn);

    expect(isNew).toBe(true);
    expect(mockRedisClient.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'gpay:buffer:prov_1',
      'txn_123',
      JSON.stringify(txn),
      '3600',
    );
  });

  it('should return false if eval returns 0 (duplicate)', async () => {
    mockRedisClient.eval.mockResolvedValueOnce(0);

    const txn = {
      txnId: 'txn_123',
      amount: 100,
      timestamp: new Date(),
      status: 'COMPLETED',
      customerName: 'A',
      customerVpa: 'a@vpa',
      utr: 'UTR',
      note: 'Note',
    };

    const isNew = await (service as any).bufferToRedis('prov_1', txn);
    expect(isNew).toBe(false);
  });
});
