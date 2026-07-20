import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { createHmac } from 'crypto';

describe('Webhooks API (Integration)', () => {
    let app: INestApplication;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    const generateWebhookSignature = (data: any): string => {
        const secret = process.env.WEBHOOK_SECRET || 'test-webhook-secret';
        return createHmac('sha256', secret)
            .update(JSON.stringify(data))
            .digest('hex');
    };

    describe('POST /webhooks/callback', () => {
        let testOrderId: string;

        beforeAll(async () => {
            // Create a test order
            const orderRes = await request(app.getHttpServer())
                .post('/orders')
                .send({
                    amount: 1000,
                    merchantId: 'test-merchant',
                });

            testOrderId = orderRes.body.order.id;
        });

        it('should accept valid webhook with correct signature', () => {
            const payload = {
                orderId: testOrderId,
                status: 'SUCCESS',
                transactionId: 'txn-123',
                amount: 1000,
            };

            const signature = generateWebhookSignature(payload);

            return request(app.getHttpServer())
                .post('/webhooks/callback')
                .send({
                    ...payload,
                    signature,
                })
                .expect(200)
                .expect((res) => {
                    expect(res.body.success).toBe(true);
                });
        });

        it('should reject webhook with invalid signature', () => {
            return request(app.getHttpServer())
                .post('/webhooks/callback')
                .send({
                    orderId: testOrderId,
                    status: 'SUCCESS',
                    signature: 'invalid-signature',
                })
                .expect(401);
        });

        it('should reject webhook without signature', () => {
            return request(app.getHttpServer())
                .post('/webhooks/callback')
                .send({
                    orderId: testOrderId,
                    status: 'SUCCESS',
                })
                .expect(400);
        });

        it('should update order status on successful webhook', async () => {
            const payload = {
                orderId: testOrderId,
                status: 'COMPLETED',
                transactionId: 'txn-456',
            };

            const signature = generateWebhookSignature(payload);

            await request(app.getHttpServer())
                .post('/webhooks/callback')
                .send({
                    ...payload,
                    signature,
                })
                .expect(200);

            // Verify order status was updated
            const orderRes = await request(app.getHttpServer())
                .get(`/orders/${testOrderId}`);

            expect(orderRes.body.order.status).toBe('COMPLETED');
        });

        it('should handle failed payment webhook', () => {
            const payload = {
                orderId: testOrderId,
                status: 'FAILED',
                errorMessage: 'Insufficient funds',
            };

            const signature = generateWebhookSignature(payload);

            return request(app.getHttpServer())
                .post('/webhooks/callback')
                .send({
                    ...payload,
                    signature,
                })
                .expect(200)
                .expect((res) => {
                    expect(res.body.success).toBe(true);
                });
        });
    });

    describe('POST /webhooks/resend', () => {
        it('should resend failed webhooks', () => {
            return request(app.getHttpServer())
                .post('/webhooks/resend')
                .send({
                    webhookId: 'test-webhook-id',
                })
                .expect(200);
        });
    });
});
