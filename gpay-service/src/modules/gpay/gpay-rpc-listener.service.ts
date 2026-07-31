import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GpayRpcParserService, GpayParsedTransaction } from './gpay-rpc-parser.service';
import { RedisService } from '../../common/redis/redis.service';
import { GpayPaymentEventProducer } from './queue/gpay-payment-event.producer';
import { BrowserPoolService } from './browser-pool.service';
import { Page, Response } from 'playwright';

@Injectable()
export class GpayRpcListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GpayRpcListenerService.name);
  private readonly redisTtlSeconds: number;
  private readonly appendScript = `
    local key = KEYS[1]
    local val = ARGV[1]
    local ttl = tonumber(ARGV[2])
    redis.call("rpush", key, val)
    redis.call("expire", key, ttl)
    return 1
  `;

  constructor(
    private readonly rpcParser: GpayRpcParserService,
    private readonly redisService: RedisService,
    private readonly eventProducer: GpayPaymentEventProducer,
    private readonly configService: ConfigService,
    private readonly browserPoolService: BrowserPoolService,
  ) {
    this.redisTtlSeconds = Number(
      this.configService.get('GPAY_RPC_BUFFER_TTL_SECONDS') || 3600,
    );
  }

  onModuleInit() {
    this.logger.log('GpayRpcListenerService initialized');
  }

  onModuleDestroy() {
    this.logger.log('GpayRpcListenerService destroyed');
  }

  /**
   * Attach network listener to a Playwright Page for batchexecute and push notifications.
   */
  attachListener(page: Page, providerId: string, merchantId: string): void {
    page.on('response', async (response: Response) => {
      try {
        const url = response.url();
        if (
          !url.includes('batchexecute') &&
          !url.includes('notifications') &&
          !url.includes('stream')
        ) {
          return;
        }

        const isRPtkab = url.includes('batchexecute') && url.includes('rpcids=RPtkab');
        const isYuZqtb = url.includes('batchexecute') && url.includes('rpcids=yuZqtb');

        if (!isRPtkab && !isYuZqtb && !url.includes('notifications')) {
          return;
        }

        const rawText = await response.text().catch(() => null);
        if (!rawText) return;

        this.browserPoolService.updateLastActivity(providerId);

        let parsedTransactions: any[] = [];
        if (isRPtkab || isYuZqtb) {
          parsedTransactions = this.rpcParser.parseBatchexecuteResponse(rawText);
        } else {
          const notif = this.rpcParser.parsePushNotification(rawText);
          if (notif) parsedTransactions = [notif];
        }

        if (!Array.isArray(parsedTransactions) || parsedTransactions.length === 0) {
          return;
        }

        this.logger.log(
          `[RPC Listener] Captured ${parsedTransactions.length} txns for provider ${providerId}`,
        );

        for (const txn of parsedTransactions) {
          // Normalize fields from parser output
          const normalizedTxn: GpayParsedTransaction = {
            txnId: txn.transactionId || txn.txnId || '',
            utr: txn.utr || null,
            amount: txn.amount || 0,
            customerName: txn.customerName || null,
            customerVpa: txn.payerVpa || txn.customerVpa || null,
            timestamp: txn.timestamp || new Date(),
            status: 'COMPLETED',
            note: txn.note || null,
          };

          await this.bufferToRedis(providerId, normalizedTxn);

          // Enqueue BullMQ reconciliation event with SHA-256 job ID
          await this.eventProducer.producePaymentEvent({
            providerId,
            merchantId,
            transaction: {
              txnId: normalizedTxn.txnId,
              utr: normalizedTxn.utr,
              timestamp: normalizedTxn.timestamp.toISOString(),
              amount: normalizedTxn.amount,
              customerName: normalizedTxn.customerName,
              vpa: normalizedTxn.customerVpa,
              status: normalizedTxn.status,
              note: normalizedTxn.note,
            },
            source: isRPtkab ? 'RPtkab' : 'yuZqtb',
          });
        }
      } catch (error: any) {
        this.logger.debug(
          `[RPC Listener] Non-blocking parse error for provider ${providerId}: ${error.message}`,
        );
      }
    });
  }

  private async bufferToRedis(
    providerId: string,
    txn: GpayParsedTransaction,
  ): Promise<void> {
    try {
      const client = this.redisService.getClient();
      const key = `gpay:buffer:${providerId}`;
      const payload = JSON.stringify(txn);
      await client.eval(
        this.appendScript,
        1,
        key,
        payload,
        String(this.redisTtlSeconds),
      );
    } catch (e: any) {
      this.logger.warn(
        `Failed to buffer RPC transaction to Redis for ${providerId}: ${e.message}`,
      );
    }
  }
}
