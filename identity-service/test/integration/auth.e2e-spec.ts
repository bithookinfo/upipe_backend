import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

describe('Authentication API (Integration)', () => {
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

    describe('POST /auth/register', () => {
        const testMobile = `9${Math.floor(Math.random() * 1000000000)}`;

        it('should register new user successfully', () => {
            return request(app.getHttpServer())
                .post('/auth/register')
                .send({
                    mobile: testMobile,
                    password: 'Password123!',
                    name: 'Test User',
                })
                .expect(201)
                .expect((res) => {
                    expect(res.body.user).toBeDefined();
                    expect(res.body.user.mobile).toBe(testMobile);
                    expect(res.body.accessToken).toBeDefined();
                });
        });

        it('should reject duplicate mobile registration', async () => {
            const duplicateMobile = `9${Math.floor(Math.random() * 1000000000)}`;

            // Register first time
            await request(app.getHttpServer())
                .post('/auth/register')
                .send({
                    mobile: duplicateMobile,
                    password: 'Password123!',
                    name: 'First User',
                })
                .expect(201);

            // Try to register again with same mobile
            return request(app.getHttpServer())
                .post('/auth/register')
                .send({
                    mobile: duplicateMobile,
                    password: 'Password123!',
                    name: 'Second User',
                })
                .expect(409);
        });

        it('should reject weak password', () => {
            return request(app.getHttpServer())
                .post('/auth/register')
                .send({
                    mobile: `9${Math.floor(Math.random() * 1000000000)}`,
                    password: '123',
                    name: 'Weak Pass User',
                })
                .expect(400);
        });

        it('should require mobile and password', () => {
            return request(app.getHttpServer())
                .post('/auth/register')
                .send({
                    name: 'No Credentials User',
                })
                .expect(400);
        });
    });

    describe('POST /auth/login', () => {
        const loginMobile = `9${Math.floor(Math.random() * 1000000000)}`;
        const loginPassword = 'LoginPass123!';

        beforeAll(async () => {
            // Create test user for login tests
            await request(app.getHttpServer())
                .post('/auth/register')
                .send({
                    mobile: loginMobile,
                    password: loginPassword,
                    name: 'Login Test User',
                });
        });

        it('should login with valid credentials', () => {
            return request(app.getHttpServer())
                .post('/auth/login')
                .send({
                    mobile: loginMobile,
                    password: loginPassword,
                })
                .expect(200)
                .expect((res) => {
                    expect(res.body.accessToken).toBeDefined();
                    expect(res.body.user).toBeDefined();
                    expect(res.body.user.mobile).toBe(loginMobile);
                });
        });

        it('should reject invalid password', () => {
            return request(app.getHttpServer())
                .post('/auth/login')
                .send({
                    mobile: loginMobile,
                    password: 'WrongPassword123!',
                })
                .expect(401);
        });

        it('should reject non-existent user', () => {
            return request(app.getHttpServer())
                .post('/auth/login')
                .send({
                    mobile: '9999999999',
                    password: 'Password123!',
                })
                .expect(401);
        });

        it('should require both mobile and password', () => {
            return request(app.getHttpServer())
                .post('/auth/login')
                .send({
                    mobile: loginMobile,
                })
                .expect(400);
        });
    });

    describe('POST /auth/change-password', () => {
        let authToken: string;
        const userMobile = `9${Math.floor(Math.random() * 1000000000)}`;
        const oldPassword = 'OldPass123!';
        const newPassword = 'NewPass456!';

        beforeAll(async () => {
            // Register and login to get token
            const registerRes = await request(app.getHttpServer())
                .post('/auth/register')
                .send({
                    mobile: userMobile,
                    password: oldPassword,
                    name: 'Change Password User',
                });

            authToken = registerRes.body.accessToken;
        });

        it('should change password with valid token', () => {
            return request(app.getHttpServer())
                .post('/auth/change-password')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    currentPassword: oldPassword,
                    newPassword: newPassword,
                })
                .expect(200);
        });

        it('should reject without authentication', () => {
            return request(app.getHttpServer())
                .post('/auth/change-password')
                .send({
                    currentPassword: oldPassword,
                    newPassword: newPassword,
                })
                .expect(401);
        });

        it('should reject with wrong current password', () => {
            return request(app.getHttpServer())
                .post('/auth/change-password')
                .set('Authorization', `Bearer ${authToken}`)
                .send({
                    currentPassword: 'WrongCurrent123!',
                    newPassword: 'AnotherNew123!',
                })
                .expect(401);
        });
    });
});
