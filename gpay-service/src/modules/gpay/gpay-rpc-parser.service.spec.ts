import { GpayRpcParserService } from './gpay-rpc-parser.service';

describe('GpayRpcParserService', () => {
  let service: GpayRpcParserService;

  beforeEach(() => {
    service = new GpayRpcParserService();
  });

  describe('parseBatchexecuteResponse', () => {
    it('should parse valid RPtkab transaction response array', () => {
      const sampleResponse =
        `)]}'\n` +
        JSON.stringify([
          [
            'wrb.fr',
            'RPtkab',
            JSON.stringify([
              [
                [
                  'txn_123',
                  'UTR123456789',
                  [Math.floor(Date.now() / 1000), 0],
                  ['INR', 50],
                  1,
                  1,
                  null,
                  null,
                  ['Customer Name', 'cust@okhdfcbank'],
                ],
              ],
            ]),
          ],
        ]);

      const txns = service.parseBatchexecuteResponse(sampleResponse);
      expect(txns).toHaveLength(1);
      expect(txns[0].transactionId).toBe('txn_123');
      expect(txns[0].amount).toBe(50);
      expect(txns[0].utr).toBe('UTR123456789');
      expect(txns[0].customerName).toBe('Customer Name');
      expect(txns[0].payerVpa).toBe('cust@okhdfcbank');
    });

    it('should ignore non-completed or zero amount transactions', () => {
      const sampleResponse =
        `)]}'\n` +
        JSON.stringify([
          [
            'wrb.fr',
            'RPtkab',
            JSON.stringify([
              [
                [
                  'txn_failed',
                  'UTR111',
                  [Math.floor(Date.now() / 1000), 0],
                  ['INR', 50],
                  1,
                  2,
                  null,
                  null,
                  ['Customer', 'cust@okhdfc'],
                ],
                [
                  'txn_zero',
                  'UTR222',
                  [Math.floor(Date.now() / 1000), 0],
                  ['INR', 0],
                  1,
                  1,
                  null,
                  null,
                  ['Customer', 'cust@okhdfc'],
                ],
              ],
            ]),
          ],
        ]);

      const txns = service.parseBatchexecuteResponse(sampleResponse);
      expect(txns).toHaveLength(0);
    });
  });

  describe('parsePushNotification', () => {
    it('should parse valid push notification transaction', () => {
      const pushText = JSON.stringify([
        [
          'push_1',
          'UTR9999',
          [Math.floor(Date.now() / 1000), 0],
          ['INR', 100],
          1,
          1,
          null,
          null,
          ['John Doe', 'john@okaxis'],
        ],
      ]);

      const txn = service.parsePushNotification(pushText);
      expect(txn).toBeDefined();
      expect(txn?.transactionId).toBe('push_1');
      expect(txn?.amount).toBe(100);
      expect(txn?.utr).toBe('UTR9999');
    });

    it('should return null for invalid push format', () => {
      const txn = service.parsePushNotification('invalid json');
      expect(txn).toBeNull();
    });
  });
});
