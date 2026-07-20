import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

describe('Payment Links API (Integration)', () => {
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

    describe('POST /payment-links', () => {
        it('should generate payment link', () => {
            return request(app.getHttpServer())
                .post('/payment-links')
                .send({
                    orderId: 'test-order-id', // Would typically create order first
                    amount: 500,
                    merchantId: 'test-merchant',
                })
                .expect(201)
                .expect((res) => {
                    expect(res.body.paymentUrl).toBeDefined();
                });
        });

        it('should require amount and merchantId', () => {
            return request(app.getHttpServer())
                .post('/payment-links')
                .send({})
                .expect(400);
        });
    });
});
