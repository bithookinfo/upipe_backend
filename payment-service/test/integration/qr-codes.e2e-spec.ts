import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

describe('QR Codes API (Integration)', () => {
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

    describe('POST /qr-codes', () => {
        it('should generate QR code', () => {
            return request(app.getHttpServer())
                .post('/qr-codes')
                .send({
                    amount: 100,
                    merchantId: 'test-merchant',
                    providerId: 'PAYTM',
                })
                .expect(201)
                .expect((res) => {
                    expect(res.body.qrCodeUrl).toBeDefined();
                    expect(res.body.upiString).toBeDefined();
                });
        });

        it('should require provider', () => {
            return request(app.getHttpServer())
                .post('/qr-codes')
                .send({
                    amount: 100,
                    merchantId: 'test-merchant',
                })
                .expect(400);
        });
    });
});
