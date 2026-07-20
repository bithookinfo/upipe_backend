import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

describe('Permissions API (Integration)', () => {
    let app: INestApplication;
    let adminToken: string;
    let userId: string;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        await app.init();

        // Setup: Register admin user and login to get token
        const mobile = `9${Math.floor(Math.random() * 1000000000)}`;
        const registerRes = await request(app.getHttpServer())
            .post('/auth/register')
            .send({
                mobile,
                password: 'Password123!',
                name: 'Admin User',
            });

        userId = registerRes.body.user.id;
        adminToken = registerRes.body.accessToken;
    });

    afterAll(async () => {
        await app.close();
    });

    describe('GET /permissions', () => {
        it('should list all permissions', () => {
            return request(app.getHttpServer())
                .get('/permissions')
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200)
                .expect((res) => {
                    expect(Array.isArray(res.body)).toBe(true);
                });
        });

        it('should require authentication', () => {
            return request(app.getHttpServer())
                .get('/permissions')
                .expect(401);
        });
    });

    describe('POST /permissions/grant', () => {
        it('should grant permission to user', () => {
            return request(app.getHttpServer())
                .post('/permissions/grant')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    userId,
                    permissionId: 'settings.view', // Assuming this permission exists or seed data
                })
                .expect(201)
                .expect((res) => {
                    expect(res.body.success).toBe(true);
                });
        });
    });

    describe('DELETE /permissions/revoke', () => {
        it('should revoke permission from user', () => {
            return request(app.getHttpServer())
                .delete('/permissions/revoke')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    userId,
                    permissionId: 'settings.view',
                })
                .expect(200)
                .expect((res) => {
                    expect(res.body.success).toBe(true);
                });
        });
    });

    describe('GET /permissions/user/:userId', () => {
        it('should get user permissions', () => {
            return request(app.getHttpServer())
                .get(`/permissions/user/${userId}`)
                .set('Authorization', `Bearer ${adminToken}`)
                .expect(200)
                .expect((res) => {
                    expect(Array.isArray(res.body)).toBe(true);
                });
        });
    });
});
