import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../../src/app.module";

describe("Business Categories API (Integration)", () => {
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

  describe("GET /categories", () => {
    it("should list all categories", () => {
      return request(app.getHttpServer())
        .get("/categories")
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
        });
    });
  });

  describe("POST /categories", () => {
    const categoryName = `Test Category ${Date.now()}`;

    it("should create new category", () => {
      return request(app.getHttpServer())
        .post("/categories")
        .send({
          name: categoryName,
          description: "Test Description",
          isActive: true,
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.name).toBe(categoryName);
        });
    });

    it("should require name", () => {
      return request(app.getHttpServer())
        .post("/categories")
        .send({
          description: "Test Description",
        })
        .expect(400);
    });
  });
});
